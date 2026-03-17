"""
EXIF metadata caching - stores extracted EXIF dates to avoid repeated file I/O.
"""

import json
import os
import threading
from pathlib import Path
from datetime import datetime
from flask import current_app

_cache = {}
_cache_lock = threading.Lock()
_cache_loaded = False


def _get_cache_path() -> Path:
    """Get the path to the EXIF cache file."""
    data_dir = Path(current_app.config.get("DATA_DIR", "data"))
    return data_dir / "exif_cache.json"


def _load_cache():
    """Load cache from disk if not already loaded."""
    global _cache, _cache_loaded
    if _cache_loaded:
        return

    cache_path = _get_cache_path()
    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                _cache = json.load(f)
        except json.JSONDecodeError, IOError:
            _cache = {}

    _cache_loaded = True


def _save_cache():
    """Save cache to disk."""
    cache_path = _get_cache_path()
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(_cache, f, indent=2)


def _get_cache_key(path: Path) -> str:
    """Generate cache key from file path and modification time."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0
    return f"{path.resolve()}:{mtime}"


def get_cached_exif_date(path: Path) -> datetime | None:
    """Get cached EXIF date for a file."""
    _load_cache()

    key = _get_cache_key(path)
    cached = _cache.get(key)

    if cached:
        try:
            return datetime.fromisoformat(cached)
        except ValueError, TypeError:
            pass

    return None


def set_cached_exif_date(path: Path, exif_date: datetime):
    """Cache EXIF date for a file."""
    _load_cache()

    key = _get_cache_key(path)
    _cache[key] = exif_date.isoformat()

    # Debounce writes - save in background after delay
    threading.Timer(2.0, _save_cache).start()


def invalidate_cache(path: Path):
    """Invalidate cached EXIF data for a file."""
    _load_cache()

    key = _get_cache_key(path)
    _cache.pop(key, None)

    threading.Timer(1.0, _save_cache).start()


def clear_all_cache():
    """Clear all cached EXIF data."""
    global _cache, _cache_loaded
    _cache = {}
    _cache_loaded = True
    _save_cache()
