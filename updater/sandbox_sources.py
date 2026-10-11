"""Content identity of the inputs copied into the two sandbox images."""

from __future__ import annotations

import hashlib
import subprocess
from typing import Mapping


SOURCE_LABEL = "io.aivory.sandbox.source"
SOURCE_PATHS = (
    "sandbox-service/Dockerfile.sidecar",
    "sandbox-service/requirements.txt",
    "sandbox-service/app.py",
    "sandbox-service/Dockerfile.runner",
    "sandbox-service/runner-requirements.txt",
)
OPTIONAL_PATHS = ("sandbox-service/.dockerignore",)


def source_fingerprint(blobs: Mapping[str, str]) -> str:
    missing = set(SOURCE_PATHS) - blobs.keys()
    if missing:
        raise ValueError("sandbox source metadata is incomplete")
    digest = hashlib.sha256(b"aivory-sandbox-source-v1\0")
    for path in sorted(SOURCE_PATHS + OPTIONAL_PATHS):
        if path in blobs:
            digest.update(f"{path}\0{blobs[path]}\0".encode())
    return digest.hexdigest()


def checkout_fingerprint() -> str:
    # Git blob IDs depend on file contents, not the release tag, timestamps, or
    # Docker layers. GitHub's tree API exposes the same IDs for older images.
    tree = subprocess.check_output(
        ["git", "ls-tree", "-r", "HEAD", "--", "sandbox-service"], text=True,
    )
    blobs = {}
    for line in tree.splitlines():
        metadata, path = line.split("\t", 1)
        _, kind, sha = metadata.split()
        if kind == "blob":
            blobs[path] = sha
    return source_fingerprint(blobs)


if __name__ == "__main__":
    print(f"sandbox_source={checkout_fingerprint()}")
