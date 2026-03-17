"""
Thumbnail disk caching - stores generated thumbnails to avoid repeated processing.
"""

import hashlib
import os
import threading
from pathlib import Path
from flask import current_app

_cache_dir = None


def _get_thumb_dir() -> Path:
    """Get the thumbnail cache directory."""
    global _cache_dir
    if _cache_dir is None:
        data_dir = Path(current_app.config.get("DATA_DIR", "data"))
        _cache_dir = data_dir / "thumbs"
        _cache_dir.mkdir(parents=True, exist_ok=True)
    return _cache_dir


def get_thumb_cache_path(source_path: Path, size: int) -> Path:
    """Get the cache path for a thumbnail."""
    try:
        mtime = int(source_path.stat().st_mtime)
    except OSError:
        mtime = 0

    key = f"{source_path.resolve()}:{mtime}:{size}"
    hash_key = hashlib.md5(key.encode()).hexdigest()
    ext = ".jpg"

    return _get_thumb_dir() / f"{hash_key}{ext}"


def get_cached_thumb(source_path: Path, size: int) -> bytes | None:
    """Get cached thumbnail data if available and fresh."""
    cache_path = get_thumb_cache_path(source_path, size)

    if not cache_path.exists():
        return None

    try:
        # Verify source file hasn't been modified since cache was created
        source_mtime = int(source_path.stat().st_mtime)
        cache_mtime = int(cache_path.stat().st_mtime)

        if source_mtime > cache_mtime:
            return None

        return cache_path.read_bytes()
    except OSError:
        return None


def save_thumb_cache(source_path: Path, size: int, thumb_data: bytes):
    """Save thumbnail to cache."""
    cache_path = get_thumb_cache_path(source_path, size)

    try:
        cache_path.write_bytes(thumb_data)
    except OSError:
        pass


def clear_thumb_cache():
    """Clear all cached thumbnails."""
    thumb_dir = _get_thumb_dir()
    for f in thumb_dir.glob("*.jpg"):
        try:
            f.unlink()
        except OSError:
            pass
