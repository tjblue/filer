#!/usr/bin/env python3
"""
WSGI entry point for Gunicorn.
"""

import os
from pathlib import Path

from app import create_app
from app.quicktransfer.service import qt_ensure_directories
from app.quicktransfer.cleanup import start_cleanup_thread
from app.trash.service import trash_ensure_directories
from app.trash.cleanup import start_trash_cleanup_thread


# Get configuration from environment variables
ROOT_DIR = Path(os.environ.get('FILER_ROOT', '.')).resolve()
PORT = int(os.environ.get('FILER_PORT', 5000))

if not ROOT_DIR.is_dir():
    raise ValueError(f"Error: {ROOT_DIR} is not a valid directory")

# Initialize Quick Transfer
qt_ensure_directories()
start_cleanup_thread()

# Initialize Trash
trash_ensure_directories()
start_trash_cleanup_thread()

# Create Flask app
app = create_app(ROOT_DIR, PORT)

print(f"Serving files from: {ROOT_DIR}")
print(f"Server configured for port: {PORT}")

# This is the application object that Gunicorn will use
application = app

if __name__ == '__main__':
    # For development/testing only
    app.run(debug=True)
