"""
Trash background cleanup thread for expired items.
"""

import time
import threading
from app.trash.service import (
    trash_metadata_lock,
    trash_load_metadata,
    trash_delete_permanently,
    trash_is_expired
)


@trash_metadata_lock
def trash_cleanup_once():
    """Keep failed deletions tracked so later cleanup passes can retry them."""
    metadata = trash_load_metadata()
    removed = 0
    for trash_id, item in metadata['items'].items():
        if trash_is_expired(item):
            result = trash_delete_permanently(trash_id)
            if result['success']:
                removed += 1
    return removed


def trash_cleanup_expired():
    """Background worker for expired trash items."""
    while True:
        time.sleep(300)
        try:
            removed = trash_cleanup_once()
            if removed:
                print(f"[Trash Cleanup] Removed {removed} expired items")
        except Exception as e:
            print(f"[Trash Cleanup Error] {e}")


def start_trash_cleanup_thread():
    """Start the trash cleanup background thread"""
    cleanup_thread = threading.Thread(target=trash_cleanup_expired, daemon=True)
    cleanup_thread.start()
    return cleanup_thread
