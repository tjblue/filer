"""
Quick Transfer service layer - handles metadata, storage, and business logic.
"""

import os
import json
import uuid
import socket
from app.storage import MetadataLock, save_json
from datetime import datetime, timedelta
from app.config import QT_UPLOAD_FOLDER, QT_METADATA_FILE

# Thread lock for metadata file access
qt_metadata_lock = MetadataLock(lambda: QT_METADATA_FILE)


def qt_ensure_directories():
    """Create required directories for Quick Transfer"""
    os.makedirs(QT_UPLOAD_FOLDER, exist_ok=True)
    os.makedirs(os.path.dirname(QT_METADATA_FILE), exist_ok=True)


def qt_load_metadata():
    """Load Quick Transfer metadata from JSON file"""
    with qt_metadata_lock.transaction():
        if os.path.exists(QT_METADATA_FILE):
            try:
                with open(QT_METADATA_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return {"items": {}}
        return {"items": {}}


def qt_save_metadata(data):
    """Save Quick Transfer metadata to JSON file"""
    with qt_metadata_lock.transaction():
        save_json(QT_METADATA_FILE, data)


def qt_generate_id():
    """Generate a short unique ID"""
    return uuid.uuid4().hex[:8]


def qt_format_size(bytes_count):
    """Format file size for display"""
    if bytes_count < 1024:
        return f"{bytes_count} B"
    if bytes_count < 1024 * 1024:
        return f"{bytes_count / 1024:.1f} KB"
    if bytes_count < 1024 * 1024 * 1024:
        return f"{bytes_count / (1024 * 1024):.1f} MB"
    return f"{bytes_count / (1024 * 1024 * 1024):.1f} GB"


def qt_format_time_remaining(expires_at_str):
    """Format time remaining until expiration"""
    expires_at = datetime.fromisoformat(expires_at_str)
    now = datetime.now()
    diff = expires_at - now

    if diff.total_seconds() <= 0:
        return "Expired"

    hours = int(diff.total_seconds() // 3600)
    minutes = int((diff.total_seconds() % 3600) // 60)

    if hours >= 24:
        days = hours // 24
        remaining_hours = hours % 24
        return f"{days}d {remaining_hours}h"
    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def qt_is_expired(item):
    """Check if an item has expired"""
    expires_at = datetime.fromisoformat(item['expires_at'])
    return datetime.now() > expires_at


@qt_metadata_lock
def qt_get_item(item_id):
    """Get item by ID, returning None if not found or expired"""
    metadata = qt_load_metadata()
    item = metadata['items'].get(item_id)

    if item and qt_is_expired(item):
        qt_delete_item(item_id)
        return None

    return item


@qt_metadata_lock
def qt_delete_item(item_id):
    """Remove item from storage"""
    metadata = qt_load_metadata()
    item = metadata['items'].get(item_id)

    if item:
        if item['type'] == 'file':
            file_path = os.path.join(QT_UPLOAD_FOLDER, item['stored_name'])
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except OSError:
                    pass

        del metadata['items'][item_id]
        qt_save_metadata(metadata)
        return True
    return False


def qt_get_local_ip():
    """Get the local network IP address"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'
