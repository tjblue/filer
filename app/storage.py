"""Serialized JSON transactions shared by threads and server processes."""

import json
import os
import tempfile
import threading
from contextlib import contextmanager
from functools import wraps
from pathlib import Path


class MetadataLock:
    def __init__(self, filename):
        self.filename = filename
        self._lock = threading.RLock()
        self._local = threading.local()

    @contextmanager
    def transaction(self):
        with self._lock:
            if getattr(self._local, "active", False):
                yield
                return
            path = Path(str(self.filename()) + ".lock")
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a+b") as handle:
                if os.name == "nt":
                    import msvcrt
                    handle.seek(0, os.SEEK_END)
                    if handle.tell() == 0:
                        handle.write(b"\0")
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX)
                self._local.active = True
                try:
                    yield
                finally:
                    self._local.active = False
                    if os.name == "nt":
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(handle, fcntl.LOCK_UN)

    def __call__(self, function):
        @wraps(function)
        def locked(*args, **kwargs):
            with self.transaction():
                return function(*args, **kwargs)
        return locked


def save_json(filename, data):
    """Replace a JSON file atomically, preserving the old file on failure."""
    path = Path(filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
