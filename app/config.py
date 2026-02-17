"""
Configuration constants for Filer application.
"""

# Quick Transfer configuration
QT_UPLOAD_FOLDER = 'data/uploads'
QT_METADATA_FILE = 'data/metadata.json'
DEFAULT_EXPIRY_HOURS = 2
MAX_EXPIRY_DAYS = 7
MAX_FILE_SIZE_MB = 5120  # 5 GB

# Trash configuration
TRASH_FOLDER = 'data/trash'
TRASH_METADATA_FILE = 'data/trash_metadata.json'
TRASH_RETENTION_DAYS = 14

# Chunked upload configuration
CHUNK_SIZE = 5 * 1024 * 1024  # 5 MB

# Settings configuration
SETTINGS_FILE = 'data/settings.json'
