"""
Trash service layer - handles metadata, storage, and business logic.
"""

import os
import json
import uuid
import shutil
from app.storage import MetadataLock, save_json
from datetime import datetime, timedelta
from pathlib import Path
from app.config import TRASH_FOLDER, TRASH_METADATA_FILE, TRASH_RETENTION_DAYS

# Thread lock for metadata file access
trash_metadata_lock = MetadataLock(lambda: TRASH_METADATA_FILE)


def trash_ensure_directories():
    """Create required directories for Trash"""
    os.makedirs(TRASH_FOLDER, exist_ok=True)
    os.makedirs(os.path.dirname(TRASH_METADATA_FILE), exist_ok=True)


def trash_load_metadata():
    """Load Trash metadata from JSON file"""
    with trash_metadata_lock.transaction():
        if os.path.exists(TRASH_METADATA_FILE):
            try:
                with open(TRASH_METADATA_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return {"items": {}}
        return {"items": {}}


def trash_save_metadata(data):
    """Save Trash metadata to JSON file"""
    with trash_metadata_lock.transaction():
        save_json(TRASH_METADATA_FILE, data)


def trash_generate_id():
    """Generate a short unique ID"""
    return uuid.uuid4().hex[:8]


def trash_format_size(bytes_count):
    """Format file size for display"""
    if bytes_count is None:
        return "-"
    if bytes_count < 1024:
        return f"{bytes_count} B"
    if bytes_count < 1024 * 1024:
        return f"{bytes_count / 1024:.1f} KB"
    if bytes_count < 1024 * 1024 * 1024:
        return f"{bytes_count / (1024 * 1024):.1f} MB"
    return f"{bytes_count / (1024 * 1024 * 1024):.1f} GB"


def trash_format_time_remaining(deleted_at_str):
    """Format time remaining until permanent deletion"""
    deleted_at = datetime.fromisoformat(deleted_at_str)
    expires_at = deleted_at + timedelta(days=TRASH_RETENTION_DAYS)
    now = datetime.now()
    diff = expires_at - now

    if diff.total_seconds() <= 0:
        return "Expired"

    days = int(diff.total_seconds() // 86400)
    hours = int((diff.total_seconds() % 86400) // 3600)

    if days > 0:
        return f"{days}d {hours}h"
    if hours > 0:
        minutes = int((diff.total_seconds() % 3600) // 60)
        return f"{hours}h {minutes}m"
    minutes = int(diff.total_seconds() // 60)
    return f"{minutes}m"


def trash_is_expired(item):
    """Check if an item has expired (past retention period)"""
    deleted_at = datetime.fromisoformat(item['deleted_at'])
    expires_at = deleted_at + timedelta(days=TRASH_RETENTION_DAYS)
    return datetime.now() > expires_at


def trash_get_size(path):
    """Get size of file or directory"""
    if os.path.isfile(path):
        return os.path.getsize(path)
    elif os.path.isdir(path):
        total = 0
        for dirpath, dirnames, filenames in os.walk(path):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                try:
                    total += os.path.getsize(fp)
                except (OSError, IOError):
                    pass
        return total
    return 0


@trash_metadata_lock
def trash_move_to_trash(path, root_dir):
    """
    Move a file or folder to trash.

    Args:
        path: Relative path within root_dir
        root_dir: The root directory (Path object)

    Returns:
        dict with trash_id and metadata, or None on failure
    """
    root_dir = Path(root_dir).resolve()
    full_path = (root_dir / path).resolve()
    if not full_path.is_relative_to(root_dir) or full_path == root_dir:
        raise ValueError("Cannot trash paths outside the root or the root itself")
    path = full_path.relative_to(root_dir).as_posix()

    if not full_path.exists():
        return None

    trash_id = trash_generate_id()
    name = full_path.name
    is_directory = full_path.is_dir()
    size = trash_get_size(str(full_path))

    # Create storage directory for this item
    storage_dir = os.path.join(TRASH_FOLDER, trash_id)
    os.makedirs(storage_dir, exist_ok=True)

    # Move file/folder to trash storage
    dest_path = os.path.join(storage_dir, name)
    try:
        shutil.move(str(full_path), dest_path)
    except (OSError, shutil.Error) as e:
        # Clean up storage dir on failure
        try:
            os.rmdir(storage_dir)
        except:
            pass
        raise e

    # Create metadata entry
    item_metadata = {
        "trash_id": trash_id,
        "original_path": path,
        "original_root": str(root_dir),
        "name": name,
        "is_directory": is_directory,
        "size": size,
        "deleted_at": datetime.now().isoformat()
    }

    # Save to metadata file
    metadata = trash_load_metadata()
    metadata['items'][trash_id] = item_metadata
    try:
        trash_save_metadata(metadata)
    except OSError:
        # Metadata failure must not strand an untracked file in Trash.
        shutil.move(dest_path, str(full_path))
        os.rmdir(storage_dir)
        raise

    return item_metadata


@trash_metadata_lock
def trash_restore(trash_id, root_dir):
    """
    Restore an item from trash to its original location.

    Args:
        trash_id: The trash item ID
        root_dir: The root directory (Path object)

    Returns:
        dict with success status and message
    """
    metadata = trash_load_metadata()
    item = metadata['items'].get(trash_id)

    if not item:
        return {"success": False, "error": "Item not found in trash"}

    root_dir = Path(root_dir).resolve()
    original_root = item.get("original_root")
    if not original_root:
        return {"success": False, "error": "Original root is unknown for this legacy item; recover it manually from trash storage"}
    if root_dir != Path(original_root).resolve():
        return {"success": False, "error": f"Restore requires the original root: {original_root}"}

    # Check if item still exists in trash storage
    storage_path = os.path.join(TRASH_FOLDER, trash_id, item['name'])
    if not os.path.exists(storage_path):
        # Remove from metadata since storage is gone
        del metadata['items'][trash_id]
        trash_save_metadata(metadata)
        return {"success": False, "error": "Item no longer exists in trash storage"}

    # Check if original location is available
    root_dir = Path(root_dir).resolve()
    dest_path = (root_dir / item['original_path']).resolve()
    if not dest_path.is_relative_to(root_dir) or dest_path == root_dir:
        return {"success": False, "error": "Restore destination is outside the root"}
    if dest_path.exists():
        return {"success": False, "error": f"Cannot restore: '{item['original_path']}' already exists"}

    # Ensure parent directory exists
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    # Move back to original location
    try:
        shutil.move(storage_path, str(dest_path))
    except (OSError, shutil.Error) as e:
        return {"success": False, "error": f"Failed to restore: {str(e)}"}

    # Clean up empty trash storage directory
    storage_dir = os.path.join(TRASH_FOLDER, trash_id)
    try:
        os.rmdir(storage_dir)
    except:
        pass

    # Remove from metadata
    del metadata['items'][trash_id]
    trash_save_metadata(metadata)

    return {"success": True, "restored_path": item['original_path']}


@trash_metadata_lock
def trash_delete_permanently(trash_id):
    """
    Permanently delete an item from trash.

    Args:
        trash_id: The trash item ID

    Returns:
        dict with success status
    """
    metadata = trash_load_metadata()
    item = metadata['items'].get(trash_id)

    if not item:
        return {"success": False, "error": "Item not found in trash"}

    # Delete from storage
    storage_dir = os.path.join(TRASH_FOLDER, trash_id)
    if os.path.exists(storage_dir):
        try:
            shutil.rmtree(storage_dir)
        except OSError as e:
            return {"success": False, "error": f"Failed to delete: {str(e)}"}

    # Remove from metadata
    del metadata['items'][trash_id]
    trash_save_metadata(metadata)

    return {"success": True}


def trash_list_items():
    """
    List all items in trash.

    Returns:
        list of trash items with formatted fields
    """
    metadata = trash_load_metadata()
    items = []

    for trash_id, item in metadata['items'].items():
        items.append({
            "trash_id": item['trash_id'],
            "name": item['name'],
            "original_path": item['original_path'],
            "original_root": item.get('original_root'),
            "is_directory": item['is_directory'],
            "size": item['size'],
            "size_formatted": trash_format_size(item['size']),
            "deleted_at": item['deleted_at'],
            "time_remaining": trash_format_time_remaining(item['deleted_at']),
            "is_expired": trash_is_expired(item)
        })

    # Sort by deletion time, most recent first
    items.sort(key=lambda x: x['deleted_at'], reverse=True)

    return items


@trash_metadata_lock
def trash_empty_all():
    """
    Empty entire trash - permanently delete all items.

    Returns:
        dict with count of deleted items
    """
    metadata = trash_load_metadata()
    count = 0
    errors = []
    for trash_id in list(metadata['items']):
        result = trash_delete_permanently(trash_id)
        if result['success']:
            count += 1
        else:
            errors.append({"id": trash_id, "error": result['error']})
    return {"success": not errors, "deleted_count": count, "errors": errors}
