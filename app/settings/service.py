"""
Settings service layer - handles reading/writing application settings.
"""

import os
import json
from app.storage import MetadataLock, save_json
from app.config import SETTINGS_FILE

# Thread lock for settings file access
settings_lock = MetadataLock(lambda: SETTINGS_FILE)

DEFAULT_SETTINGS = {
    "theme": "dark",
    "fontSize": "medium",
    "previewScale": "off"
}


def settings_ensure_directory():
    """Create required directory for settings file."""
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)


def settings_load():
    """Load settings from JSON file."""
    with settings_lock.transaction():
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return dict(DEFAULT_SETTINGS)
        return dict(DEFAULT_SETTINGS)


def settings_save(data):
    """Save settings to JSON file."""
    settings_ensure_directory()
    with settings_lock.transaction():
        save_json(SETTINGS_FILE, data)
