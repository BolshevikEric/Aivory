"""Read actual workspace tarballs with mocked Docker/storage boundaries."""

import ast
import base64
from contextlib import nullcontext
import gzip
import io
from pathlib import Path
import re
from subprocess import CompletedProcess, TimeoutExpired
import subprocess
import tarfile
import time
from types import SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import Mock


APP_PATH = Path(__file__).resolve().parents[2] / "sandbox-service" / "app.py"
SESSION = "a" * 32


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def workspace_archive(entries, *, tar_format=tarfile.PAX_FORMAT):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tar_format) as archive:
        for name, data in entries:
            entry = tarfile.TarInfo(name)
            if isinstance(data, bytes):
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            else:
                entry.type = data[0]
                entry.linkname = "outputs/report.txt"
                archive.addfile(entry)
    return buf.getvalue()


class ArchiveBrowserTest(unittest.TestCase):
    def setUp(self):
        self.storage = {"provider": "local", "prefix": "data/"}
        self.get_object = Mock()
        self.docker = Mock(return_value=CompletedProcess([], 0, b"true\n", b""))
        self.globals = {
            "__name__": "archive_browser_test_functions",
            "Optional": Optional, "ArchiveFilesBody": SimpleNamespace,
            "HTTPException": HTTPException, "re": re,
            "base64": base64, "gzip": gzip, "io": io, "tarfile": tarfile,
            "time": time, "subprocess": subprocess,
            "MAX_ARCHIVE_SCAN_BYTES": 1024 * 1024,
            "MAX_ARCHIVE_BYTES": 1024 * 1024,
            "MAX_ARCHIVE_MEMBERS": 1000, "MAX_UPLOAD_BYTES": 10000,
            "ARCHIVE_TIMEOUT_S": 30,
            "_archive_browser_slots": object(),
            "_slot": lambda *args: nullcontext(),
            "_storage_effective": lambda storage: bool(storage),
            "_storage_get_object": self.get_object,
            "_workspace_archive_key": lambda storage, stem: storage["prefix"] + "workspaces/" + stem + ".tgz",
            "_docker": self.docker,
            "_container": lambda session: "sandbox-" + session,
        }
        names = {"_valid_session", "_sanitize_archive_key", "_require_browsable_session",
                 "_archive_relative_path", "_ArchiveScanReader", "_ArchiveTarInfo",
                 "_inspect_workspace_archive", "_browse_workspace_archive",
                 "list_archived_files", "get_archived_file"}
        tree = ast.parse(APP_PATH.read_text(encoding="utf-8"))
        nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
        self.assertEqual({node.name for node in nodes}, names)
        for node in nodes:
            node.decorator_list = []
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(APP_PATH), "exec"), self.globals)
        self.body = SimpleNamespace(archive_key="conv_example", session_id=SESSION, path="", storage=self.storage)

    def list_files(self):
        return self.globals["list_archived_files"](self.body)

    def get_file(self, path):
        self.body.path = path
        return self.globals["get_archived_file"](self.body)

    def test_list_and_preview_saved_files_without_docker_or_restore(self):
        self.get_object.return_value = workspace_archive([
            ("./outputs/report.txt", b"report"), ("./uploads/data.csv", b"a,b\n"),
            ("./skills/example.py", b"print(1)"), ("downloads/image.png", b"\x00\xff\x01"),
            ("outputs/empty.txt", b""),
        ])
        result = self.list_files()
        self.assertEqual(result["archive_status"], "ready")
        self.assertEqual(len(result["files"]), 5)
        self.assertEqual(result["files"][0], {"path": "downloads/image.png", "size": 3})
        self.assertEqual(base64.b64decode(self.get_file("downloads/image.png")["data_base64"]), b"\x00\xff\x01")
        self.assertEqual(self.get_file("outputs/empty.txt"), {"archive_status": "ready", "data_base64": ""})
        self.docker.assert_not_called()
        self.get_object.assert_called_with(self.storage, "data/workspaces/conv_example.tgz", max_bytes=1024 * 1024)

    def test_missing_storage_and_archive_are_distinct(self):
        self.body.storage = None
        self.assertEqual(self.list_files(), {"archive_status": "not_configured"})
        self.get_object.assert_not_called()
        self.body.storage = self.storage
        self.get_object.return_value = None
        self.assertEqual(self.list_files(), {"archive_status": "missing"})
        self.assertEqual(self.get_object.call_count, 2)

    def test_legacy_archive_fallback_only_when_stable_key_is_missing(self):
        self.get_object.side_effect = [None, workspace_archive([("outputs/report.txt", b"ok")])]
        self.assertEqual(self.list_files()["files"], [{"path": "outputs/report.txt", "size": 2}])
        self.assertEqual(self.get_object.call_args.args[1], "data/workspaces/" + SESSION + ".tgz")
        self.get_object.reset_mock(side_effect=True)
        self.get_object.side_effect = OSError("storage unavailable")
        with self.assertRaises(HTTPException) as raised:
            self.list_files()
        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("storage unavailable", raised.exception.detail)
        self.assertEqual(self.get_object.call_count, 1)

    def test_corrupt_archive_is_not_treated_as_missing_or_empty(self):
        self.get_object.return_value = b"not a tarball"
        with self.assertRaises(HTTPException) as raised:
            self.list_files()
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(self.get_object.call_count, 1)

    def test_links_traversal_and_special_files_are_never_exposed(self):
        self.get_object.return_value = workspace_archive([
            ("../secret", b"bad"), ("/etc/passwd", b"bad"), ("folder/../secret", b"bad"),
            ("outputs/link", (tarfile.SYMTYPE,)), ("outputs/hardlink", (tarfile.LNKTYPE,)),
            ("outputs/pipe", (tarfile.FIFOTYPE,)), ("outputs/good.txt", b"ok"),
        ])
        self.assertEqual(self.list_files()["files"], [{"path": "outputs/good.txt", "size": 2}])
        self.assertEqual(self.get_file("outputs/link"), {"archive_status": "file_missing"})
        for path in ("../secret", "/etc/passwd", "a//b", "a/./b", "./a", "a\\b", "a\x00b", ""):
            with self.subTest(path=path), self.assertRaises(HTTPException) as raised:
                self.get_file(path)
            self.assertEqual(raised.exception.status_code, 400)

    def test_invalid_archive_keys_and_session_ids_never_reach_storage(self):
        for key in ("../secret", "", "a/b", "x" * 129):
            self.body.archive_key = key
            with self.subTest(key=key), self.assertRaises(HTTPException):
                self.list_files()
        self.body.archive_key = "conv_example"
        self.body.session_id = "../secret"
        with self.assertRaises(HTTPException):
            self.list_files()
        self.get_object.assert_not_called()

    def test_decompression_file_size_member_count_and_metadata_are_bounded(self):
        self.get_object.return_value = workspace_archive([("large.txt", b"x" * 11000)])
        with self.assertRaises(HTTPException):
            self.get_file("large.txt")
        self.globals["MAX_ARCHIVE_SCAN_BYTES"] = 8192
        with self.assertRaises(HTTPException):
            self.list_files()
        self.globals["MAX_ARCHIVE_SCAN_BYTES"] = 1024 * 1024
        self.globals["MAX_ARCHIVE_MEMBERS"] = 1
        self.get_object.return_value = workspace_archive([("a.txt", b"a"), ("b.txt", b"b")])
        with self.assertRaises(HTTPException):
            self.list_files()
        self.globals["MAX_ARCHIVE_MEMBERS"] = 1000
        self.get_object.return_value = workspace_archive([("x" * 70000, b"")], tar_format=tarfile.GNU_FORMAT)
        with self.assertRaises(HTTPException) as raised:
            self.list_files()
        self.assertIn("metadata exceeds", raised.exception.detail)

    def test_genuine_session_expiry_and_docker_failure_are_distinguished(self):
        require = self.globals["_require_browsable_session"]
        require(SESSION)
        for cp in (CompletedProcess([], 0, b"false\n", b""),
                   CompletedProcess([], 1, b"", b"Error: No such object: sandbox-a")):
            self.docker.return_value = cp
            with self.assertRaises(HTTPException) as raised:
                require(SESSION)
            self.assertEqual(raised.exception.status_code, 404)
        self.docker.return_value = CompletedProcess([], 1, b"", b"Cannot connect to Docker daemon")
        with self.assertRaises(HTTPException) as raised:
            require(SESSION)
        self.assertEqual(raised.exception.status_code, 503)
        self.docker.side_effect = TimeoutExpired("docker", 20)
        with self.assertRaises(HTTPException) as raised:
            require(SESSION)
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
