import importlib.util
import os
import stat
import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch

try:
    from updater.sandbox_sources import SOURCE_LABEL, SOURCE_PATHS, source_fingerprint
except ModuleNotFoundError:
    from sandbox_sources import SOURCE_LABEL, SOURCE_PATHS, source_fingerprint


SPEC = importlib.util.spec_from_file_location("aivory_updater", Path(__file__).with_name("updater.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class UpdateManagerTest(unittest.TestCase):
    def make_manager(self):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        compose = root / "compose.yml"
        compose.write_text("services: {}\n", encoding="utf-8")
        env = root / ".env"
        env.write_text("IMAGE_TAG=2.4.7\nKEEP=this\n", encoding="utf-8")
        values = {
            "AIVORY_UPDATER_STATE_DIR": str(root / "state"),
            "AIVORY_UPDATER_TOKEN_FILE": str(root / "shared" / "token"),
            "AIVORY_UPDATER_COMPOSE_FILE": str(compose),
            "AIVORY_UPDATER_ENV_FILE": str(env),
        }
        with patch.dict(os.environ, values, clear=False):
            manager = MODULE.UpdateManager(MODULE.Settings())
        return temp, manager, env

    def test_rejects_non_semantic_or_injected_version(self):
        temp, manager, _ = self.make_manager()
        self.addCleanup(temp.cleanup)
        for version in ("latest", "v2.4.8", "2.4.8+build", "2.4.8-rc.01", "2.04.8", "2.4.8;id", "2.4"):
            with self.assertRaises(ValueError):
                manager.start(version)

    def test_accepts_prerelease_version(self):
        temp, manager, _ = self.make_manager()
        self.addCleanup(temp.cleanup)
        with patch.object(manager, "_run", return_value=None):
            job, started = manager.start("2.4.9-beta.2")
        self.assertTrue(started)
        self.assertEqual(job["version"], "2.4.9-beta.2")

    def test_env_update_preserves_other_values(self):
        temp, manager, env = self.make_manager()
        self.addCleanup(temp.cleanup)
        previous = manager._write_env_value("APP_IMAGE_TAG", "2.4.8")
        self.assertIsNone(previous)
        self.assertEqual(env.read_text(encoding="utf-8"), "IMAGE_TAG=2.4.7\nKEEP=this\nAPP_IMAGE_TAG=2.4.8\n")
        manager._restore_env_value("APP_IMAGE_TAG", previous)
        self.assertEqual(env.read_text(encoding="utf-8"), "IMAGE_TAG=2.4.7\nKEEP=this\n")

    def test_env_update_preserves_file_permissions(self):
        temp, manager, env = self.make_manager()
        self.addCleanup(temp.cleanup)
        os.chmod(env, 0o640)
        manager._write_env_value("APP_IMAGE_TAG", "2.4.8")
        self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o640)

    def test_single_flight(self):
        temp, manager, _ = self.make_manager()
        self.addCleanup(temp.cleanup)
        with patch.object(manager, "_run", return_value=None):
            first, started = manager.start("2.4.8")
            second, started_again = manager.start("2.4.9")
        self.assertTrue(started)
        self.assertFalse(started_again)
        self.assertEqual(first["id"], second["id"])

    def test_compose_uses_real_host_data_mount(self):
        temp, manager, _ = self.make_manager()
        self.addCleanup(temp.cleanup)
        calls = []

        def command(args, timeout=600, env=None):
            calls.append((args, env))
            if args[:3] == ["docker", "inspect", "--format"]:
                return '[{"Source":"/srv/aivory/data","Destination":"/shared"}]'
            return ""

        with patch.object(manager, "_command", side_effect=command):
            manager._compose("ps", "-q", "app")
        self.assertEqual(calls[-1][1]["DATA_DIR"], "/srv/aivory/data")

    def deployment(self, manager, sandbox=True, changed=False, external=False):
        prefix = manager.settings.image_repository.removesuffix("/aivory-app")
        old_source, new_source = "a" * 64, "b" * 64 if changed else "a" * 64
        snapshots = {
            "app": {"Image": "sha256:old-app", "Config": {}},
            "sandbox": {"Image": "sha256:old-sidecar", "Config": {"Env": [f"SANDBOX_IMAGE={prefix}/aivory-sandbox:old"]}},
            "sandbox-image-keepalive": {"Image": "sha256:old-runtime", "Config": {}},
        }
        if not sandbox:
            snapshots.pop("sandbox")
            snapshots.pop("sandbox-image-keepalive")
        events = []

        def compose(*args, **kwargs):
            events.append(("compose", args))
            self.assertIn("--profile", args)
            self.assertIn("*", args)
            values = dict(line.split("=", 1) for line in manager.settings.env_file.read_text().splitlines() if "=" in line)
            app_tag = values.get("APP_IMAGE_TAG", values.get("IMAGE_TAG", "latest"))
            sandbox_tag = values.get("SANDBOX_IMAGE_TAG", values.get("IMAGE_TAG", "latest"))
            return json.dumps({"services": {
                "app": {"image": f"{prefix}/aivory-app:{app_tag}"},
                "sandbox": {"image": "custom/sandbox:latest" if external else f"{prefix}/aivory-sandbox-sidecar:{sandbox_tag}", "environment": {"SANDBOX_IMAGE": f"{prefix}/aivory-sandbox:{sandbox_tag}"}},
                "sandbox-image-keepalive": {"image": f"{prefix}/aivory-sandbox:{sandbox_tag}"},
            }})

        def command(args, **kwargs):
            events.append(("command", args))
            self.assertEqual(args[:2], ["docker", "pull"])
            return ""

        def labels(image):
            return {SOURCE_LABEL: old_source if image.startswith("sha256:old") else new_source}

        for method, replacement in {
            "_compose": compose, "_command": command, "_image_labels": labels,
            "_service_snapshot": lambda service: snapshots.get(service),
            "_compose_up": lambda services, overrides=None: events.append(("restart", list(services), overrides)),
            "_wait_healthy": lambda *args, **kwargs: events.append(("health", args, kwargs)),
        }.items():
            patcher = patch.object(manager, method, side_effect=replacement)
            patcher.start()
            self.addCleanup(patcher.stop)
        return events

    def run_deployment(self, **options):
        temp, manager, env = self.make_manager()
        self.addCleanup(temp.cleanup)
        events = self.deployment(manager, **options)
        return manager, env, events

    def test_unchanged_code_does_not_pull_or_restart_sandbox(self):
        manager, env, events = self.run_deployment()
        manager._run("2.5.1-beta.15")
        self.assertEqual(manager.snapshot()["status"], "completed")
        self.assertEqual(manager.snapshot()["sandbox_status"], "unchanged")
        pulls = [event[1][-1] for event in events if event[0] == "command"]
        self.assertEqual(pulls, [manager.settings.image_repository + ":2.5.1-beta.15"])
        self.assertEqual([event[1] for event in events if event[0] == "restart"], [["app"]])
        self.assertNotIn("SANDBOX_IMAGE_TAG=", env.read_text())

    def test_changed_code_updates_both_sandbox_images_before_the_app(self):
        manager, env, events = self.run_deployment(changed=True)
        manager._run("2.5.1-beta.15")
        self.assertEqual(manager.snapshot()["status"], "completed")
        self.assertEqual(manager.snapshot()["sandbox_status"], "updated")
        self.assertIn("SANDBOX_IMAGE_TAG=2.5.1-beta.15\n", env.read_text())
        pulls = [event[1][-1] for event in events if event[0] == "command"]
        self.assertEqual(len(pulls), 3)
        self.assertTrue(all(image.endswith(":2.5.1-beta.15") for image in pulls))
        first_restart = next(index for index, event in enumerate(events) if event[0] == "restart")
        self.assertEqual(len([event for event in events[:first_restart] if event[0] == "command"]), 3)
        self.assertEqual([event[1] for event in events if event[0] == "restart"], [["sandbox-image-keepalive", "sandbox"], ["app"]])

    def test_optional_sandbox_is_not_enabled_by_an_app_update(self):
        manager, _, events = self.run_deployment(sandbox=False, changed=True)
        manager._run("2.5.1-beta.15")
        self.assertEqual(manager.snapshot()["sandbox_status"], "not_running")
        self.assertEqual([event[1] for event in events if event[0] == "restart"], [["app"]])

    def test_custom_sandbox_is_not_replaced(self):
        manager, _, events = self.run_deployment(external=True, changed=True)
        manager._run("2.5.1-beta.15")
        self.assertEqual(manager.snapshot()["sandbox_status"], "external")
        self.assertEqual([event[1] for event in events if event[0] == "restart"], [["app"]])

    def test_incomplete_release_leaves_old_services_and_env_untouched(self):
        manager, env, events = self.run_deployment(changed=True)
        before = env.read_text()
        original = manager._command.side_effect

        def command(args, **kwargs):
            if "/aivory-sandbox:" in args[-1]:
                raise RuntimeError("sandbox image is not published")
            return original(args, **kwargs)

        with patch.object(manager, "_command", side_effect=command):
            manager._run("2.5.1-beta.15")
        self.assertEqual(manager.snapshot()["status"], "failed")
        self.assertEqual(env.read_text(), before)
        self.assertFalse(any(event[0] == "restart" for event in events))

    def test_mismatched_sandbox_source_stops_before_any_restart(self):
        manager, env, events = self.run_deployment(changed=True)
        before = env.read_text()
        original = manager._image_labels.side_effect
        with patch.object(manager, "_image_labels", side_effect=lambda image: {SOURCE_LABEL: "c" * 64} if "aivory-sandbox:" in image else original(image)):
            manager._run("2.5.1-beta.15")
        self.assertEqual(manager.snapshot()["status"], "failed")
        self.assertIn("source does not match", manager.snapshot()["error"])
        self.assertEqual(env.read_text(), before)
        self.assertFalse(any(event[0] == "restart" for event in events))

    def test_app_health_failure_restores_exact_images_and_environment(self):
        manager, env, events = self.run_deployment(changed=True)
        env.write_text("IMAGE_TAG=latest\nAPP_IMAGE_TAG=2.5.1-beta.14\nSANDBOX_IMAGE_TAG=latest\nKEEP=this\n")
        before = env.read_text()
        checks = []

        def health(service=None, **kwargs):
            checks.append(service)
            if service is None:
                raise RuntimeError("app health failed")

        with patch.object(manager, "_wait_healthy", side_effect=health):
            manager._run("2.5.1-beta.15")
        self.assertEqual(manager.snapshot()["status"], "failed")
        self.assertEqual(manager.snapshot()["sandbox_status"], "rolled_back")
        self.assertEqual(env.read_text(), before)
        rollback = [event for event in events if event[0] == "restart"][-1]
        self.assertEqual(rollback[1], ["sandbox-image-keepalive", "sandbox", "app"])
        self.assertEqual(rollback[2]["app"]["image"], "sha256:old-app")
        self.assertEqual(rollback[2]["sandbox"]["image"], "sha256:old-sidecar")
        self.assertEqual(rollback[2]["sandbox-image-keepalive"]["image"], "sha256:old-runtime")
        self.assertTrue(all(value["pull_policy"] == "never" for value in rollback[2].values()))

    def test_sandbox_health_failure_does_not_replace_old_app(self):
        manager, env, events = self.run_deployment(changed=True)
        before = env.read_text()
        count = 0

        def health(service=None, **kwargs):
            nonlocal count
            if service == "sandbox":
                count += 1
                if count == 1:
                    raise RuntimeError("sandbox health failed")

        with patch.object(manager, "_wait_healthy", side_effect=health):
            manager._run("2.5.1-beta.15")
        self.assertEqual(manager.snapshot()["status"], "failed")
        self.assertEqual(env.read_text(), before)
        self.assertTrue(all("app" not in event[1] for event in events if event[0] == "restart"))

    def test_legacy_images_compare_source_contents_and_cache_build_commits(self):
        temp, manager, _ = self.make_manager()
        self.addCleanup(temp.cleanup)
        blobs = {path: "d" * 40 for path in SOURCE_PATHS}
        tree = {"tree": [{"path": path, "sha": sha, "type": "blob"} for path, sha in blobs.items()]}
        labels = {"org.opencontainers.image.source": "https://github.com/hjxwz123/Aivory", "org.opencontainers.image.revision": "e" * 40}
        cache = {}
        with patch.object(MODULE.urllib.request, "urlopen") as request:
            request.return_value.__enter__.return_value.read.return_value = json.dumps(tree).encode()
            self.assertEqual(manager._source_fingerprint(labels, cache), source_fingerprint(blobs))
            self.assertEqual(manager._source_fingerprint(labels, cache), source_fingerprint(blobs))
            self.assertEqual(request.call_count, 1)

    def test_source_fingerprint_ignores_docs_but_detects_runtime_or_sidecar_changes(self):
        blobs = {path: "a" * 40 for path in SOURCE_PATHS}
        expected = source_fingerprint(blobs)
        self.assertEqual(source_fingerprint({**blobs, "sandbox-service/README.md": "b" * 40}), expected)
        for path in SOURCE_PATHS:
            self.assertNotEqual(source_fingerprint({**blobs, path: "b" * 40}), expected)

    def test_unknown_source_does_not_guess_that_an_upgrade_is_needed(self):
        temp, manager, _ = self.make_manager()
        self.addCleanup(temp.cleanup)
        with self.assertRaisesRegex(RuntimeError, "cannot safely determine"):
            manager._source_fingerprint({}, {})


if __name__ == "__main__":
    unittest.main()
