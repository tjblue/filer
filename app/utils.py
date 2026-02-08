"""
Shared utility functions for file operations.
"""

from pathlib import Path
from datetime import datetime
from flask import abort, current_app


def safe_path(requested_path: str) -> Path:
    """Validate and return a safe path within ROOT_DIR."""
    ROOT_DIR = current_app.config['ROOT_DIR']

    if not requested_path:
        return ROOT_DIR

    # Normalize and resolve the path
    clean_path = requested_path.replace('\\', '/').strip('/')

    # Reject any path traversal attempts
    if '..' in clean_path.split('/'):
        abort(403, 'Path traversal not allowed')

    full_path = (ROOT_DIR / clean_path).resolve()

    # Ensure the path is within ROOT_DIR
    try:
        full_path.relative_to(ROOT_DIR)
    except ValueError:
        abort(403, 'Access denied')

    return full_path


def get_file_info(path: Path, relative_to: Path) -> dict:
    """Get file/folder information."""
    stat = path.stat()
    return {
        'name': path.name,
        'path': str(path.relative_to(relative_to)).replace('\\', '/'),
        'isDirectory': path.is_dir(),
        'size': stat.st_size if path.is_file() else None,
        'modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }
