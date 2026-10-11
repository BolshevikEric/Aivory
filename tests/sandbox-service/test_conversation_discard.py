"""Exercise the actual deletion functions with Docker/storage boundaries mocked.

Extracting the functions keeps these regressions independent of FastAPI, cloud
SDKs, and a Docker daemon while executing the production failure paths.
"""

import ast
from contextlib import nullcontext
from pathlib import Path
import re
from subprocess import CompletedProcess
from types import SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import Mock


APP_PATH = Path(__file__).resolve().parents[2] / "sandbox-service" / "app.py"
SESSION = "a" * 32
ARCHIVE = "conv_example"


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class ConversationDiscardTest(unittest.TestCase):
    def setUp(self):
        self.storage = {"provider": "local", "prefix": "data/"}
        self.docker = Mock(return_value=CompletedProcess([], 0, b"", b""))
        self.delete_object = Mock()
        self.archive = Mock()
        self.forget = Mock()
        self.globals = {
            "Optional": Optional,
            "DeleteBody": SimpleNamespace,
            "Body": lambda **kwargs: None,
            "HTTPException": HTTPException,
            "re": re,
            "_docker": self.docker,
            "_storage_delete_object": self.delete_object,
            "_storage_effective": lambda storage: bool(storage),
            "_session_storage_for": lambda session: self.storage,
            "_session_lock": lambda session: nullcontext(),
            "_set_terminating": Mock(),
            "_forget": self.forget,
            "_container": lambda session: "sandbox-" + session,
            "_archive_workspace": self.archive,
            "_archive_stem": lambda session: session,
            "_workspace_archive_key": lambda storage, stem: storage["prefix"] + "workspaces/" + stem + ".tgz",
        }
        tree = ast.parse(APP_PATH.read_text(encoding="utf-8"))
        names = {"delete_session", "delete_archive", "_purge_archive", "_valid_session", "_sanitize_archive_key"}
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        for function in functions:
            function.decorator_list = []
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(APP_PATH), "exec"), self.globals)
        self.body = SimpleNamespace(discard=True, archive_key=ARCHIVE, storage=self.storage)

    def delete(self):
        return self.globals["delete_session"](SESSION, self.body)

    def test_discard_destroys_container_and_both_stable_and_legacy_archives(self):
        self.assertEqual(self.delete(), {"ok": True})
        self.archive.assert_not_called()
        self.docker.assert_called_once_with(["rm", "-f", "sandbox-" + SESSION], timeout=30)
        self.assertEqual(
            {call.args[1] for call in self.delete_object.call_args_list},
            {"data/workspaces/" + ARCHIVE + ".tgz", "data/workspaces/" + SESSION + ".tgz"},
        )
        self.forget.assert_called_once_with(SESSION)

    def test_already_reaped_container_still_purges_archive(self):
        self.docker.return_value = CompletedProcess([], 1, b"", b"Error response from daemon: No such container")
        self.assertEqual(self.delete(), {"ok": True})
        self.assertEqual(self.delete_object.call_count, 2)

    def test_archive_failure_still_destroys_container_and_reports_failure_for_retry(self):
        self.delete_object.side_effect = OSError("storage unavailable")
        with self.assertRaises(HTTPException) as raised:
            self.delete()
        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("storage unavailable", raised.exception.detail)
        self.docker.assert_called_once()
        self.archive.assert_not_called()
        self.delete_object.side_effect = None
        self.assertEqual(self.delete(), {"ok": True})

    def test_docker_daemon_failure_cannot_be_reported_as_success(self):
        self.docker.return_value = CompletedProcess([], 1, b"", b"Cannot connect to Docker daemon")
        with self.assertRaises(HTTPException) as raised:
            self.delete()
        self.assertEqual(raised.exception.status_code, 500)
        self.forget.assert_not_called()

    def test_archive_only_purge_never_calls_docker_and_propagates_storage_failure(self):
        self.assertEqual(self.globals["delete_archive"](ARCHIVE, self.body), {"ok": True})
        self.docker.assert_not_called()
        self.delete_object.assert_called_once_with(self.storage, "data/workspaces/" + ARCHIVE + ".tgz")
        self.delete_object.side_effect = OSError("storage unavailable")
        with self.assertRaises(OSError):
            self.globals["delete_archive"](ARCHIVE, self.body)

    def test_archive_key_cannot_escape_storage_prefix(self):
        for key in ("../secret", "", "a/b", "x" * 129):
            with self.subTest(key=key), self.assertRaises(HTTPException):
                self.globals["delete_archive"](key, self.body)
        self.delete_object.assert_not_called()

    def test_ordinary_release_retains_idle_restore_behavior(self):
        self.body.discard = False
        self.assertEqual(self.delete(), {"ok": True})
        self.archive.assert_called_once_with(SESSION, self.storage)
        self.delete_object.assert_not_called()


if __name__ == "__main__":
    unittest.main()
