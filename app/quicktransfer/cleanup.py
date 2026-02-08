"""
Quick Transfer background cleanup thread for expired items.
"""

import os
import time
import threading
from app.config import QT_UPLOAD_FOLDER
from app.quicktransfer.service import (
    qt_load_metadata,
    qt_save_metadata,
    qt_is_expired
)


def qt_cleanup_expired():
    """Background thread to clean up expired items"""
    while True:
        time.sleep(300)  # Check every 5 minutes

        try:
            metadata = qt_load_metadata()
            expired_ids = []

            for item_id, item in metadata['items'].items():
                if qt_is_expired(item):
                    expired_ids.append(item_id)
                    if item['type'] == 'file':
                        file_path = os.path.join(QT_UPLOAD_FOLDER, item['stored_name'])
                        if os.path.exists(file_path):
                            try:
                                os.remove(file_path)
                            except OSError:
                                pass

            if expired_ids:
                for item_id in expired_ids:
                    del metadata['items'][item_id]
                qt_save_metadata(metadata)
                print(f"[Quick Transfer Cleanup] Removed {len(expired_ids)} expired items")
        except Exception as e:
            print(f"[Quick Transfer Cleanup Error] {e}")


def start_cleanup_thread():
    """Start the cleanup background thread"""
    cleanup_thread = threading.Thread(target=qt_cleanup_expired, daemon=True)
    cleanup_thread.start()
    return cleanup_thread
