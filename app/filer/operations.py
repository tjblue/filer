"""Staged copy/move operations and bounded ZIP inspection/extraction."""

import os
import shutil
import stat
import tempfile
import zipfile
import zlib
from pathlib import Path

from flask import Blueprint, abort, current_app, jsonify, request
from werkzeug.exceptions import HTTPException

from app.filesystem import filesystem_error, json_object, validate_filename
from app.storage import MetadataLock
from app.trash.service import trash_move_to_trash, trash_restore
from app.utils import safe_path

bp = Blueprint('operations', __name__)
operation_lock = MetadataLock(lambda: Path(current_app.config['DATA_DIR']) / 'file_operations')
MAX_ARCHIVE_ENTRIES = 10000
MAX_EXTRACT_BYTES = 5 * 1024 ** 3


def operation_path(value, allow_root=False):
    if not isinstance(value, str) or (not value and not allow_root):
        abort(400, 'A path is required')
    parts = value.replace('\\', '/').strip('/').split('/') if value else []
    for part in parts:
        validate_filename(part)
        if part.startswith('.filer-'):
            abort(400, 'Reserved filename')
    # Do not resolve links into an unrelated destination, even within the root.
    raw = current_app.config['ROOT_DIR']
    for part in parts:
        raw = raw / part
        if raw.is_symlink() or raw.is_junction():
            abort(400, 'Symbolic links and junctions are not supported for this operation')
    path = safe_path(value)
    if not allow_root and path == current_app.config['ROOT_DIR']:
        abort(400, 'Cannot operate on the root directory')
    return path


def unique_destination(path):
    candidate = path
    counter = 1
    # Dots in directory names are not file extensions.
    stem, suffix = (path.name, '') if path.is_dir() else (path.stem, path.suffix)
    while os.path.lexists(candidate):
        candidate = path.with_name(f'{stem} ({counter}){suffix}')
        counter += 1
    return candidate


def copy_tree(source, destination):
    """Reject links and special files instead of following them during recursion."""
    if source.is_symlink() or source.is_junction():
        abort(400, 'Folders containing symbolic links or junctions cannot be copied')
    mode = source.stat().st_mode
    if stat.S_ISDIR(mode):
        destination.mkdir()
        for child in source.iterdir():
            validate_filename(child.name)
            if child.name.startswith('.filer-'):
                continue
            copy_tree(child, destination / child.name)
        shutil.copystat(source, destination)
    elif stat.S_ISREG(mode):
        shutil.copy2(source, destination)
    else:
        abort(400, 'Only regular files and directories can be copied')


@bp.post('/api/transfer')
def transfer():
    data = json_object(request)
    items = data.get('items')
    action = data.get('action', 'copy')
    policy = data.get('conflict', 'skip')
    if action not in ('copy', 'move') or policy not in ('skip', 'keep_both', 'replace'):
        abort(400, 'Invalid action or conflict policy')
    if not isinstance(items, list) or not items or len(items) > 1000:
        abort(400, 'Provide between 1 and 1000 items')
    completed, skipped, errors = [], [], []
    with operation_lock.transaction():
        for item in items:
            source_name = item.get('source') if isinstance(item, dict) else None
            stage = None
            backup = None
            try:
                if not isinstance(item, dict):
                    abort(400, 'Invalid transfer item')
                source = operation_path(source_name)
                destination = operation_path(item.get('destination'))
                if not source.exists():
                    abort(404, 'Source not found')
                if not destination.parent.is_dir():
                    abort(404, 'Destination folder not found')
                if source.is_dir() and destination != source and destination.is_relative_to(source):
                    abort(400, 'Cannot transfer a folder into itself')
                if source == destination and (action == 'move' or policy != 'keep_both'):
                    abort(400, 'Source and destination are the same')
                if source.is_relative_to(destination) and source != destination:
                    abort(400, 'Cannot replace a folder containing the source')
                if os.path.lexists(destination):
                    if policy == 'skip':
                        skipped.append({'source': source_name, 'reason': 'Destination exists'})
                        continue
                    if policy == 'keep_both':
                        destination = unique_destination(destination)
                # Finish copying before touching any existing destination.
                if action == 'copy':
                    stage = Path(tempfile.mkdtemp(prefix='.filer-copy-', dir=destination.parent))
                    payload = stage / 'payload'
                    copy_tree(source, payload)
                else:
                    payload = source
                if os.path.lexists(destination):
                    backup = trash_move_to_trash(destination.relative_to(current_app.config['ROOT_DIR']).as_posix(),
                                                 current_app.config['ROOT_DIR'])
                    if not backup:
                        abort(409, 'Could not back up the existing destination')
                # rename preserves folder boundaries; existing folders are never merged.
                if os.path.lexists(destination):
                    abort(409, 'Destination changed during the operation')
                payload.rename(destination)
                completed.append({'source': source_name,
                                  'destination': destination.relative_to(current_app.config['ROOT_DIR']).as_posix()})
            except (HTTPException, OSError, shutil.Error) as error:
                message = (error.description if isinstance(error, HTTPException) else
                           'File operation could not be completed' if isinstance(error, shutil.Error) else
                           filesystem_error(error)[0])
                if backup:
                    try:
                        restored = trash_restore(backup['trash_id'], current_app.config['ROOT_DIR'])
                        if not restored.get('success'):
                            message += '; previous destination is recoverable from Trash'
                    except OSError:
                        message += '; previous destination is recoverable from Trash'
                errors.append({'source': source_name, 'error': message})
            finally:
                if stage:
                    shutil.rmtree(stage, ignore_errors=True)
    return jsonify(completed=completed, skipped=skipped, errors=errors)


def inspect_zip(archive):
    entries = archive.infolist()
    if len(entries) > MAX_ARCHIVE_ENTRIES:
        abort(400, f'Archive exceeds {MAX_ARCHIVE_ENTRIES} entries')
    seen = {}
    total = 0
    for entry in entries:
        name = entry.filename
        # Use one portable interpretation on Windows and POSIX.
        if not name or name.startswith('/') or chr(92) in entry.orig_filename or chr(0) in entry.orig_filename:
            abort(400, 'Archive contains an unsafe path')
        parts = name.rstrip('/').split('/')
        for part in parts:
            validate_filename(part)
            if part.startswith('.filer-'):
                abort(400, 'Archive contains a reserved filename')
        key = '/'.join(parts).casefold()
        if key in seen:
            abort(400, 'Archive contains duplicate or ambiguous paths')
        seen[key] = entry.is_dir()
        kind = stat.S_IFMT(entry.external_attr >> 16)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.flag_bits & 1:
            abort(400, 'Encrypted archives, links, and special files are not supported')
        total += entry.file_size
        if total > MAX_EXTRACT_BYTES:
            abort(400, 'Archive exceeds the 5 GiB extraction limit')
    for key in seen:
        parts = key.split('/')
        if any(seen.get('/'.join(parts[:i])) is False for i in range(1, len(parts))):
            abort(400, 'Archive contains conflicting file and folder paths')
    return entries


@bp.get('/api/archive')
def browse_archive():
    path = operation_path(request.args.get('path'))
    try:
        with zipfile.ZipFile(path) as archive:
            entries = inspect_zip(archive)
            return jsonify(entries=[{'path': item.filename, 'size': item.file_size,
                                     'isDirectory': item.is_dir()} for item in entries])
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError):
        abort(400, 'Invalid or unsupported ZIP archive')


@bp.post('/api/archive/extract')
def extract_archive():
    data = json_object(request)
    path = operation_path(data.get('path'))
    destination = operation_path(data.get('destination'))
    members = data.get('members')
    if members is not None and (not isinstance(members, list) or not members
                                or any(not isinstance(member, str) for member in members)):
        abort(400, 'Select at least one archive entry')
    stage = None
    with operation_lock.transaction():
        if os.path.lexists(destination):
            abort(409, 'Choose a new extraction folder; destination already exists')
        if not destination.parent.is_dir():
            abort(404, 'Destination parent folder not found')
        try:
            with zipfile.ZipFile(path) as archive:
                entries = inspect_zip(archive)
                names = {entry.filename for entry in entries}
                if members is not None and any(member not in names for member in members):
                    abort(400, 'Unknown archive entry')
                chosen = None if members is None else set(members)
                stage = Path(tempfile.mkdtemp(prefix='.filer-extract-', dir=destination.parent))
                count, written = 0, 0
                for entry in entries:
                    if chosen is not None and entry.filename not in chosen and not any(
                            entry.filename.startswith(name) for name in chosen if name.endswith('/')):
                        continue
                    target = stage.joinpath(*entry.filename.rstrip('/').split('/'))
                    if entry.is_dir():
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry) as source, target.open('xb') as output:
                        while chunk := source.read(1024 * 1024):
                            written += len(chunk)
                            if written > MAX_EXTRACT_BYTES:
                                abort(400, 'Archive exceeds the 5 GiB extraction limit')
                            output.write(chunk)
                    count += 1
            if os.path.lexists(destination):
                abort(409, 'Destination changed during extraction')
            stage.rename(destination)
            stage = None
            return jsonify(destination=destination.relative_to(current_app.config['ROOT_DIR']).as_posix(),
                           extracted=count)
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError, EOFError, zlib.error):
            abort(400, 'Invalid, corrupt, or unsupported ZIP archive')
        finally:
            if stage:
                shutil.rmtree(stage, ignore_errors=True)
