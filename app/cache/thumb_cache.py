"""
Thumbnail disk caching - stores generated thumbnails to avoid repeated processing.
"""

import hashlib
from pathlib import Path
from flask import current_app

def _get_thumb_dir() -> Path:
    """Resolve the cache directory for the current app, rather than the first app."""
    data_dir = Path(current_app.config.get("DATA_DIR", "data"))
    cache_dir = data_dir / "thumbs"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def get_thumb_cache_path(source_path: Path, size: int) -> Path:
    """Get the cache path for a thumbnail."""
    try:
        mtime = source_path.stat().st_mtime_ns
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
        # The cache filename already includes the source's nanosecond mtime.
        return cache_path.read_bytes()
    except OSError:
        return None


def save_thumb_cache(source_path: Path, size: int, thumb_data: bytes, cache_path=None):
    """Save thumbnail to cache."""
    if cache_path is None:
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
