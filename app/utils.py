"""
Shared utility functions for file operations.
"""

from pathlib import Path
from datetime import datetime
from flask import abort, current_app
from PIL import Image

from app.cache.exif_cache import get_cached_exif_date, set_cached_exif_date


def safe_path(requested_path: str) -> Path:
    """Validate and return a safe path within ROOT_DIR."""
    ROOT_DIR = current_app.config["ROOT_DIR"]

    if not requested_path:
        return ROOT_DIR

    # Normalize and resolve the path
    clean_path = requested_path.replace("\\", "/").strip("/")

    # Reject any path traversal attempts
    if ".." in clean_path.split("/"):
        abort(403, "Path traversal not allowed")

    full_path = (ROOT_DIR / clean_path).resolve()

    # Ensure the path is within ROOT_DIR
    try:
        full_path.relative_to(ROOT_DIR)
    except ValueError:
        abort(403, "Access denied")

    return full_path


def get_exif_date(path: Path) -> datetime | None:
    """Extract EXIF date from image file. Returns None if not available."""
    image_extensions = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".tiff", ".tif"}

    if path.suffix.lower() not in image_extensions:
        return None

    # Check cache first
    cached = get_cached_exif_date(path)
    if cached is not None:
        return cached

    # Extract EXIF data
    try:
        with Image.open(path) as img:
            exif = img.getexif()
            if exif:
                for tag_id in [36867, 306]:
                    if tag_id in exif:
                        value = exif[tag_id]
                        dt = datetime.strptime(value, "%Y:%m:%d %H:%M:%S")
                        set_cached_exif_date(path, dt)
                        return dt
    except Exception:
        pass

    return None


def get_file_info(path: Path, relative_to: Path) -> dict:
    """Get file/folder information."""
    stat = path.stat()
    modified = datetime.fromtimestamp(stat.st_mtime)

    info = {
        "name": path.name,
        "path": str(path.relative_to(relative_to)).replace("\\", "/"),
        "isDirectory": path.is_dir(),
        "size": stat.st_size if path.is_file() else None,
        "modified": modified.isoformat(),
    }

    # Add EXIF date for images
    if path.is_file():
        exif_date = get_exif_date(path)
        if exif_date:
            info["exif_date"] = exif_date.isoformat()

    return info
