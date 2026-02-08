#!/usr/bin/env python3
"""
Start Filer with Waitress (Windows-compatible WSGI server).

Usage:
  python start_waitress.py [--root DIR] [--port PORT] [--host HOST] [--threads N]

Examples:
  python start_waitress.py
  python start_waitress.py --root C:\files
  python start_waitress.py --port 8080
  python start_waitress.py --host 127.0.0.1 --threads 8
"""

import argparse
import os
from pathlib import Path

from waitress import serve
from app import create_app
from app.quicktransfer.service import qt_ensure_directories
from app.quicktransfer.cleanup import start_cleanup_thread
from app.trash.service import trash_ensure_directories
from app.trash.cleanup import start_trash_cleanup_thread


def main():
    parser = argparse.ArgumentParser(description='Filer - Production server with Waitress')
    parser.add_argument('--root', '-r', default='.',
                        help='Root directory to serve (default: current directory)')
    parser.add_argument('--port', '-p', type=int, default=5000,
                        help='Port to run on (default: 5000)')
    parser.add_argument('--host', '-H', default='0.0.0.0',
                        help='Host to bind to (default: 0.0.0.0)')
    parser.add_argument('--threads', '-t', type=int, default=4,
                        help='Number of threads (default: 4)')
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

    print("=" * 50)
    print("Starting Filer with Waitress")
    print("=" * 50)
    print(f"Serving files from: {ROOT_DIR}")
    print(f"Binding to: {args.host}:{args.port}")
    print(f"Threads: {args.threads}")
    print(f"Server URL: http://{args.host}:{args.port}")
    print(f"Quick Transfer: http://{args.host}:{args.port}/qt/")
    print("=" * 50)
    print("\nPress Ctrl+C to stop the server")
    print()

    # Start Waitress server
    serve(
        app,
        host=args.host,
        port=args.port,
        threads=args.threads,
        url_scheme='http',
        channel_timeout=30,
        cleanup_interval=30,
        ident='Filer'
    )


if __name__ == '__main__':
    main()
