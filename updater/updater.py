#!/usr/bin/env python3
"""Persistent updates for the app and changed, running bundled sandbox."""

from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import stat
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from sandbox_sources import SOURCE_LABEL, source_fingerprint
except ModuleNotFoundError:
    from updater.sandbox_sources import SOURCE_LABEL, source_fingerprint


VERSION_RE = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-(?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?$"
)
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class Settings:
    def __init__(self) -> None:
        self.listen = os.getenv("AIVORY_UPDATER_LISTEN", "0.0.0.0:8790")
        self.state_dir = Path(os.getenv("AIVORY_UPDATER_STATE_DIR", "/var/lib/aivory-updater"))
        self.token_file = Path(os.getenv("AIVORY_UPDATER_TOKEN_FILE", "/shared/.aivory-update-token"))
        self.compose_file = Path(os.getenv("AIVORY_UPDATER_COMPOSE_FILE", "/deployment/docker-compose.prod.yml"))
        self.env_file = Path(os.getenv("AIVORY_UPDATER_ENV_FILE", "/deployment/.env"))
        self.app_service = os.getenv("AIVORY_UPDATER_APP_SERVICE", "app")
        self.image_registry = os.getenv("AIVORY_UPDATER_IMAGE_REGISTRY", "ghcr.io").rstrip("/")
        self.image_owner = os.getenv("AIVORY_UPDATER_IMAGE_OWNER", "hjxwz123").strip("/").lower()
        self.health_timeout = int(os.getenv("AIVORY_UPDATER_HEALTH_TIMEOUT_SECONDS", "180"))
        if not re.fullmatch(r"[a-z0-9][a-z0-9._/-]*", self.image_owner):
            raise ValueError("invalid image owner")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", self.app_service):
            raise ValueError("invalid app service")

    @property
    def state_file(self) -> Path:
        return self.state_dir / "state.json"

    @property
    def image_repository(self) -> str:
        return f"{self.image_registry}/{self.image_owner}/aivory-app"


class UpdateManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.lock = threading.Lock()
        self.settings.state_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_token()
        self.state = self._load_state()
        if self.state.get("status") in {"pulling", "restarting", "checking"}:
            self.state.update(status="failed", error="updater restarted before the update completed", completed_at=int(time.time()))
            self._save_state()

    def _ensure_token(self) -> None:
        self.settings.token_file.parent.mkdir(parents=True, exist_ok=True)
        try:
            current = self.settings.token_file.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            current = ""
        if len(current) >= 32:
            return
        tmp = self.settings.token_file.with_name(self.settings.token_file.name + ".tmp")
        tmp.write_text(secrets.token_urlsafe(48) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o640)
        os.replace(tmp, self.settings.token_file)

    def token(self) -> str:
        return self.settings.token_file.read_text(encoding="utf-8").strip()

    def _load_state(self) -> dict[str, Any]:
        try:
            value = json.loads(self.settings.state_file.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {"status": "idle"}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {"status": "idle"}

    def _save_state(self) -> None:
        tmp = self.settings.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.settings.state_file)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.state)

    def start(self, version: str) -> tuple[dict[str, Any], bool]:
        if not VERSION_RE.fullmatch(version) or any(
            len(identifier) > 1 and identifier.startswith("0")
            for identifier in version.partition("-")[2].split(".")
            if identifier.isdigit()
        ):
            raise ValueError("version must be a semantic image tag")
        with self.lock:
            if self.state.get("status") in {"pulling", "restarting", "checking"}:
                return dict(self.state), False
            self.state = {
                "id": uuid.uuid4().hex,
                "status": "pulling",
                "progress": "pulling_image",
                "version": version,
                "started_at": int(time.time()),
            }
            self._save_state()
            job = dict(self.state)
        threading.Thread(target=self._run, args=(version,), daemon=True).start()
        return job, True

    def _set(self, **values: Any) -> None:
        with self.lock:
            self.state.update(values)
            self._save_state()

    def _command(self, args: list[str], timeout: int = 600, env: dict[str, str] | None = None) -> str:
        completed = subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout, env=env)
        return completed.stdout.strip()

    def _host_data_dir(self) -> str:
        mounts_json = self._command([
            "docker", "inspect", "--format", "{{json .Mounts}}", os.getenv("HOSTNAME", ""),
        ], timeout=30)
        mounts = json.loads(mounts_json)
        for mount in mounts:
            if mount.get("Destination") == "/shared" and mount.get("Source"):
                return str(mount["Source"])
        raise RuntimeError("could not resolve the host data directory")

    def _compose(self, *args: str, timeout: int = 600) -> str:
        # Compose runs inside this container but creates a sibling through the
        # host daemon. Relative bind paths would otherwise resolve to the
        # container's /deployment path on the host and detach the app from its
        # real database/uploads. The /shared mount tells us the exact host path.
        command_env = os.environ.copy()
        command_env["DATA_DIR"] = self._host_data_dir()
        return self._command([
            "docker", "compose", "--env-file", str(self.settings.env_file),
            "-f", str(self.settings.compose_file), *args,
        ], timeout=timeout, env=command_env)

    def _compose_up(self, services: list[str], overrides: dict[str, Any] | None = None) -> None:
        if not overrides:
            self._compose("up", "-d", "--no-deps", "--force-recreate", *services)
            return
        # A local image ID override makes rollback independent of mutable tags
        # such as latest. This temporary file never changes the deployment YAML.
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", dir=self.settings.state_dir) as override:
            json.dump({"services": overrides}, override)
            override.flush()
            self._compose("-f", override.name, "up", "-d", "--no-deps", "--force-recreate", *services)

    def _service_snapshot(self, service: str) -> dict[str, Any] | None:
        ids = self._compose("--profile", "*", "ps", "-q", service, timeout=30).split()
        if not ids:
            return None
        if len(ids) != 1:
            raise RuntimeError(f"automatic updates require one {service} container")
        return json.loads(self._command(["docker", "inspect", ids[0]], timeout=30))[0]

    def _image_labels(self, image: str) -> dict[str, str]:
        return json.loads(self._command([
            "docker", "image", "inspect", "--format", "{{json .Config.Labels}}", image,
        ], timeout=30)) or {}

    def _source_fingerprint(self, labels: dict[str, str], cache: dict[str, str]) -> str:
        fingerprint = labels.get(SOURCE_LABEL, "")
        if re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            return fingerprint
        # Compatibility with published images that predate content labels.
        # Read their build commit's tree, not the current release or branch.
        source = urllib.parse.urlparse(labels.get("org.opencontainers.image.source", ""))
        revision = labels.get("org.opencontainers.image.revision", "")
        repository = source.path.strip("/").removesuffix(".git")
        if source.scheme != "https" or source.netloc != "github.com" or not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", revision):
            raise RuntimeError("sandbox image lacks source metadata; cannot safely determine whether its code changed")
        key = f"{repository}/{revision}"
        if key not in cache:
            request = urllib.request.Request(
                f"https://api.github.com/repos/{repository}/git/trees/{revision}?recursive=1",
                headers={"Accept": "application/vnd.github+json", "User-Agent": "Aivory-Updater"},
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise RuntimeError("sandbox source metadata is too large")
            tree = json.loads(body)
            if tree.get("truncated"):
                raise RuntimeError("sandbox source metadata is incomplete")
            cache[key] = source_fingerprint({entry["path"]: entry["sha"] for entry in tree["tree"] if entry["type"] == "blob"})
        return cache[key]

    def _sandbox_plan(self, config: dict[str, Any], app_image: str) -> dict[str, Any] | None:
        services = config.get("services", {})
        sandbox = services.get("sandbox")
        if not sandbox:
            self._set(sandbox_status="not_running")
            return None
        prefix = f"{self.settings.image_registry}/{self.settings.image_owner}/"
        if not sandbox.get("image", "").startswith(prefix + "aivory-sandbox-sidecar:"):
            self._set(sandbox_status="external")
            return None
        snapshot = self._service_snapshot("sandbox")
        if not snapshot:
            # In particular, never enable the optional personal sandbox profile.
            self._set(sandbox_status="not_running")
            return None
        environment = dict(value.split("=", 1) for value in snapshot["Config"].get("Env", []) if "=" in value)
        runtime_image = environment.get("SANDBOX_IMAGE", "")
        if not runtime_image.startswith(prefix + "aivory-sandbox:"):
            self._set(sandbox_status="external")
            return None
        cache: dict[str, str] = {}
        target = self._source_fingerprint(self._image_labels(app_image), cache)
        current = self._source_fingerprint(self._image_labels(snapshot["Image"]), cache)
        keepalive = self._service_snapshot("sandbox-image-keepalive") if "sandbox-image-keepalive" in services else None
        runtime = self._source_fingerprint(self._image_labels(keepalive["Image"] if keepalive else runtime_image), cache)
        if target == current == runtime:
            self._set(sandbox_status="unchanged")
            return None
        if not keepalive:
            raise RuntimeError("running bundled sandbox needs sandbox-image-keepalive from the current deployment Compose file")
        return {"sandbox": snapshot, "sandbox-image-keepalive": keepalive, "source": target, "runtime_image": runtime_image}

    def _write_env_value(self, key: str, value: str) -> str | None:
        if not ENV_KEY_RE.fullmatch(key) or "\n" in value or "\r" in value:
            raise ValueError("invalid environment value")
        original = self.settings.env_file.read_text(encoding="utf-8") if self.settings.env_file.exists() else ""
        previous: str | None = None
        output: list[str] = []
        replaced = False
        for line in original.splitlines(keepends=True):
            match = re.match(rf"^\s*{re.escape(key)}\s*=\s*(.*?)\s*(?:\r?\n)?$", line)
            if match and not line.lstrip().startswith("#"):
                if previous is None:
                    previous = match.group(1).strip().strip('"').strip("'")
                    output.append(f"{key}={value}\n")
                    replaced = True
                continue
            output.append(line)
        if not replaced:
            if output and not output[-1].endswith("\n"):
                output[-1] += "\n"
            output.append(f"{key}={value}\n")
        self._atomic_write_env("".join(output))
        return previous

    def _atomic_write_env(self, content: str) -> None:
        try:
            original_stat = self.settings.env_file.stat()
        except FileNotFoundError:
            original_stat = None
        tmp = self.settings.env_file.with_name(self.settings.env_file.name + ".aivory-update.tmp")
        tmp.write_text(content, encoding="utf-8")
        os.chmod(tmp, stat.S_IMODE(original_stat.st_mode) if original_stat else 0o600)
        if original_stat:
            try:
                os.chown(tmp, original_stat.st_uid, original_stat.st_gid)
            except PermissionError:
                pass
        os.replace(tmp, self.settings.env_file)

    def _restore_env_value(self, key: str, previous: str | None) -> None:
        if previous is not None:
            self._write_env_value(key, previous)
            return
        if not self.settings.env_file.exists():
            return
        original = self.settings.env_file.read_text(encoding="utf-8")
        output = [
            line for line in original.splitlines(keepends=True)
            if not re.match(rf"^\s*{re.escape(key)}\s*=", line) or line.lstrip().startswith("#")
        ]
        self._atomic_write_env("".join(output))

    def _container_id(self, service: str | None = None) -> str:
        return self._compose("--profile", "*", "ps", "-q", service or self.settings.app_service, timeout=30).strip()

    def _wait_healthy(self, service: str | None = None, healthcheck: bool = True) -> None:
        service = service or self.settings.app_service
        deadline = time.monotonic() + self.settings.health_timeout
        last = "container_missing"
        while time.monotonic() < deadline:
            container_id = self._container_id(service)
            if container_id:
                try:
                    last = self._command([
                        "docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container_id,
                    ], timeout=15)
                except (subprocess.SubprocessError, OSError):
                    last = "inspect_failed"
                if last == "healthy" or (not healthcheck and last == "running"):
                    return
                if last in {"exited", "dead"}:
                    break
            time.sleep(3)
        raise RuntimeError(f"updated {service} did not become healthy ({last})")

    def _run(self, version: str) -> None:
        original_env: str | None = None
        env_changed = False
        restarted: list[str] = []
        snapshots: dict[str, Any] = {}
        image = f"{self.settings.image_repository}:{version}"
        try:
            if not self.settings.compose_file.is_file():
                raise RuntimeError("deployment compose file is unavailable")
            self._command(["docker", "pull", image], timeout=1800)
            config = json.loads(self._compose("--profile", "*", "config", "--format", "json", timeout=30))
            app = self._service_snapshot(self.settings.app_service)
            if not app:
                raise RuntimeError("running application container is unavailable")
            snapshots[self.settings.app_service] = app
            self._set(progress="checking_sandbox", sandbox_status="checking")
            plan = self._sandbox_plan(config, image)
            if plan:
                self._set(progress="pulling_sandbox", sandbox_status="updating")
                for name in ("aivory-sandbox-sidecar", "aivory-sandbox"):
                    sandbox_image = f"{self.settings.image_registry}/{self.settings.image_owner}/{name}:{version}"
                    self._command(["docker", "pull", sandbox_image], timeout=1800)
                    if self._source_fingerprint(self._image_labels(sandbox_image), {}) != plan["source"]:
                        raise RuntimeError(f"{name} source does not match the selected application release")
                snapshots.update({service: plan[service] for service in ("sandbox", "sandbox-image-keepalive")})
            original_env = self.settings.env_file.read_text(encoding="utf-8") if self.settings.env_file.exists() else None
            env_changed = True
            self._write_env_value("APP_IMAGE_TAG", version)
            if plan:
                self._write_env_value("SANDBOX_IMAGE_TAG", version)
            updated = json.loads(self._compose("--profile", "*", "config", "--format", "json", timeout=30))["services"]
            if updated[self.settings.app_service]["image"] != image:
                raise RuntimeError("deployment Compose does not support APP_IMAGE_TAG; refresh the deployment file first")
            if plan:
                prefix = f"{self.settings.image_registry}/{self.settings.image_owner}"
                runtime_image = f"{prefix}/aivory-sandbox:{version}"
                if updated["sandbox"]["image"] != f"{prefix}/aivory-sandbox-sidecar:{version}" or updated["sandbox"].get("environment", {}).get("SANDBOX_IMAGE") != runtime_image or updated["sandbox-image-keepalive"]["image"] != runtime_image:
                    raise RuntimeError("deployment Compose does not support SANDBOX_IMAGE_TAG; refresh the deployment file first")
                self._set(status="restarting", progress="recreating_sandbox")
                restarted.extend(["sandbox-image-keepalive", "sandbox"])
                self._compose_up(["sandbox-image-keepalive", "sandbox"])
                self._set(status="checking", progress="waiting_for_sandbox_health")
                self._wait_healthy("sandbox-image-keepalive", healthcheck=False)
                self._wait_healthy("sandbox")
                self._set(sandbox_status="updated")
            self._set(status="restarting", progress="recreating_app")
            restarted.append(self.settings.app_service)
            self._compose_up([self.settings.app_service])
            self._set(status="checking", progress="waiting_for_health")
            self._wait_healthy()
            self._set(status="completed", progress="completed", completed_at=int(time.time()), error="")
        except Exception as exc:  # noqa: BLE001 - this is the task boundary
            rollback_error = ""
            if env_changed:
                try:
                    self._set(status="restarting", progress="rolling_back")
                    if original_env is None:
                        self.settings.env_file.unlink(missing_ok=True)
                    else:
                        self._atomic_write_env(original_env)
                    if restarted:
                        overrides = {service: {"image": snapshots[service]["Image"], "pull_policy": "never"} for service in restarted}
                        if "sandbox" in restarted:
                            overrides["sandbox"]["environment"] = {"SANDBOX_IMAGE": plan["runtime_image"]}
                        self._compose_up(restarted, overrides)
                        for service in restarted:
                            self._wait_healthy(service, healthcheck=service != "sandbox-image-keepalive")
                        if "sandbox" in restarted:
                            self._set(sandbox_status="rolled_back")
                except Exception as rollback_exc:  # noqa: BLE001
                    rollback_error = f"; rollback failed: {rollback_exc}"
            self._set(
                status="failed",
                progress="failed",
                error=f"{exc}{rollback_error}",
                completed_at=int(time.time()),
            )


class Handler(BaseHTTPRequestHandler):
    manager: UpdateManager

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"aivory-updater {self.address_string()} {fmt % args}", flush=True)

    def _json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self) -> bool:
        expected = f"Bearer {self.manager.token()}"
        return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._json(HTTPStatus.OK, {"ok": True})
            return
        if self.path == "/v1/status":
            if not self._authorized():
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            self._json(HTTPStatus.OK, {"job": self.manager.snapshot()})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/update":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4096:
                raise ValueError("invalid request body")
            body = json.loads(self.rfile.read(length))
            version = body.get("version", "") if isinstance(body, dict) else ""
            job, started = self.manager.start(version)
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        self._json(HTTPStatus.ACCEPTED if started else HTTPStatus.CONFLICT, {"job": job})


def main() -> None:
    settings = Settings()
    manager = UpdateManager(settings)
    Handler.manager = manager
    host, port = settings.listen.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port)), Handler)
    print(f"aivory-updater listening on {settings.listen}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
