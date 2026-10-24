"""Thread-safe EXIF caching with batched, context-independent disk writes."""

import json
import logging
import threading
from pathlib import Path
from datetime import datetime
from flask import current_app
from app.storage import save_json

_caches = {}
_cache_lock = threading.RLock()


def _get_cache_path() -> Path:
    return (Path(current_app.config.get("DATA_DIR", "data")) / "exif_cache.json").resolve()


def _load_cache(cache_path):
    """Called while holding _cache_lock; isolate state per application data folder."""
    if cache_path not in _caches:
        try:
            values = json.loads(cache_path.read_text(encoding="utf-8"))
            if not isinstance(values, dict):
                values = {}
        except (OSError, ValueError):
            values = {}
        _caches[cache_path] = {"values": values, "timer": None}
    return _caches[cache_path]


def _save_cache(cache_path):
    """The timer receives a concrete path and never touches Flask's current_app."""
    with _cache_lock:
        state = _load_cache(cache_path)
        try:
            save_json(cache_path, state["values"])
        except OSError:
            logging.getLogger(__name__).warning("Could not save EXIF cache", exc_info=True)
        finally:
            state["timer"] = None


def _schedule_save(cache_path, state):
    if state["timer"] is None:
        timer = threading.Timer(2.0, _save_cache, args=(cache_path,))
        timer.daemon = True
        state["timer"] = timer
        timer.start()


def _get_cache_key(path):
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        mtime = 0
    return f"{path.resolve()}:{mtime}"


def get_cached_exif_date(path: Path) -> datetime | None:
    with _cache_lock:
        state = _load_cache(_get_cache_path())
        cached = state["values"].get(_get_cache_key(path))
        if cached:
            try:
                return datetime.fromisoformat(cached)
            except (ValueError, TypeError):
                pass
    return None


def set_cached_exif_date(path: Path, exif_date: datetime):
    cache_path = _get_cache_path()
    with _cache_lock:
        state = _load_cache(cache_path)
        state["values"][_get_cache_key(path)] = exif_date.isoformat()
        _schedule_save(cache_path, state)


def invalidate_cache(path: Path):
    cache_path = _get_cache_path()
    with _cache_lock:
        state = _load_cache(cache_path)
        prefix = f"{path.resolve()}:"
        state["values"] = {key: value for key, value in state["values"].items()
                           if not key.startswith(prefix)}
        _schedule_save(cache_path, state)


def clear_all_cache():
    cache_path = _get_cache_path()
    with _cache_lock:
        state = _load_cache(cache_path)
        if state["timer"] is not None:
            state["timer"].cancel()
        state["values"] = {}
        _save_cache(cache_path)
