#!/usr/bin/env python3
"""
Filer - A simple directory-based file server with a modern web UI.
"""

import argparse
from pathlib import Path

from app import create_app
from app.quicktransfer.service import qt_ensure_directories
from app.quicktransfer.cleanup import start_cleanup_thread
from app.trash.service import trash_ensure_directories
from app.trash.cleanup import start_trash_cleanup_thread


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Filer - A simple file server')
    parser.add_argument('--root', '-r', default='.', help='Root directory to serve (default: current directory)')
    parser.add_argument('--port', '-p', type=int, default=5000, help='Port to run on (default: 5000)')
    parser.add_argument('--host', '-H', default='127.0.0.1', help='Host to bind to (default: 127.0.0.1)')
    args = parser.parse_args()

    ROOT_DIR = Path(args.root).resolve()

    if not ROOT_DIR.is_dir():
        print(f"Error: {ROOT_DIR} is not a valid directory")
        exit(1)

    # Initialize Quick Transfer
    qt_ensure_directories()
    start_cleanup_thread()

    # Initialize Trash
    trash_ensure_directories()
    start_trash_cleanup_thread()

    # Create Flask app
    app = create_app(ROOT_DIR, args.port)

    print(f"Serving files from: {ROOT_DIR}")
    print(f"Server running at: http://{args.host}:{args.port}")
    print(f"Quick Transfer available at: http://{args.host}:{args.port}/qt/")

    app.run(host=args.host, port=args.port, debug=True)
