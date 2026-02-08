"""
Trash background cleanup thread for expired items.
"""

import os
import time
import shutil
import threading
from app.config import TRASH_FOLDER
from app.trash.service import (
    trash_load_metadata,
    trash_save_metadata,
    trash_is_expired
)


def trash_cleanup_expired():
    """Background thread to clean up expired trash items"""
    while True:
        time.sleep(300)  # Check every 5 minutes

        try:
            metadata = trash_load_metadata()
            expired_ids = []

            for trash_id, item in metadata['items'].items():
                if trash_is_expired(item):
                    expired_ids.append(trash_id)

                    # Delete storage directory
                    storage_dir = os.path.join(TRASH_FOLDER, trash_id)
                    if os.path.exists(storage_dir):
                        try:
                            shutil.rmtree(storage_dir)
                        except OSError:
                            pass

            if expired_ids:
                for trash_id in expired_ids:
                    del metadata['items'][trash_id]
                trash_save_metadata(metadata)
                print(f"[Trash Cleanup] Removed {len(expired_ids)} expired items")
        except Exception as e:
            print(f"[Trash Cleanup Error] {e}")


def start_trash_cleanup_thread():
    """Start the trash cleanup background thread"""
    cleanup_thread = threading.Thread(target=trash_cleanup_expired, daemon=True)
    cleanup_thread.start()
    return cleanup_thread
