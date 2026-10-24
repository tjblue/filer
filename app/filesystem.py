"""Shared validation and failure-safe file writes."""

import errno
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path

from flask import abort
from werkzeug.exceptions import HTTPException


class InsufficientStorage(HTTPException):
    code = 507
    description = 'Not enough disk space'


def filesystem_error(error):
    if error.errno in (errno.ENOSPC, getattr(errno, 'EDQUOT', -1)) or getattr(error, 'winerror', None) in (39, 112):
        return 'Not enough disk space', 507
    if getattr(error, 'winerror', None) in (32, 33):
        return 'File is in use by another application', 423
    if isinstance(error, PermissionError) or error.errno == errno.EROFS:
        return 'Permission denied or read-only filesystem', 403
    if isinstance(error, FileNotFoundError):
        return 'File or directory no longer exists', 404
    if isinstance(error, FileExistsError) or isinstance(error, shutil.Error):
        return 'Destination already exists or the move cannot be completed', 409
    if error.errno in (errno.EINVAL, errno.ENAMETOOLONG, errno.ENOTDIR, errno.EISDIR):
        return 'Invalid filename or file operation', 400
    return 'File operation failed', 500


def validate_filename(name):
    if (not isinstance(name, str) or not name or name in ('.', '..')
            or name != name.strip() or name.endswith('.') or len(name) > 255
            or re.search(r'[\\/:*?"<>|\x00-\x1f]', name)
            or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', name.split('.')[0], re.I)):
        abort(400, 'Invalid filename')
    return name


def json_object(request):
    data = request.get_json()
    if not isinstance(data, dict):
        abort(400, 'Expected a JSON object')
    return data


def atomic_write_text(path, content):
    """Leave the original untouched if encoding, disk writes, or replacement fail."""
    if not isinstance(content, str):
        abort(400, 'Content must be text')
    if not os.access(path, os.W_OK):
        raise PermissionError(errno.EACCES, 'File is read-only')
    fd, temporary = tempfile.mkstemp(prefix='.filer-edit-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def publish_file(staging, destination):
    """Publish a staged file without overwriting an existing destination."""
    while True:
        candidate = destination
        counter = 1
        while os.path.lexists(candidate):
            candidate = destination.with_name(f'{destination.stem} ({counter}){destination.suffix}')
            counter += 1
        try:
            if os.name == 'nt':
                os.rename(staging, candidate)
            else:
                os.link(staging, candidate)
                Path(staging).unlink()
            return candidate
        except FileExistsError:
            continue
