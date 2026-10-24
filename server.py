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


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='Filer - A simple file server')
    parser.add_argument('--root', '-r', default='.', help='Root directory to serve (default: current directory)')
    parser.add_argument('--port', '-p', type=int, default=5000, help='Port to run on (default: 5000)')
    parser.add_argument('--host', '-H', default='127.0.0.1', help='Host to bind to (default: 127.0.0.1)')
    parser.add_argument('--debug', action='store_true', help='Enable the development debugger (localhost only)')
    parser.add_argument('--production', action='store_true', help='Serve with Waitress instead of the development server')
    args = parser.parse_args(argv)
    if args.debug and args.host not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('--debug requires a localhost binding')
    if args.debug and args.production:
        parser.error('--debug cannot be combined with --production')
    return args


if __name__ == '__main__':
    args = parse_args()

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
    print(f"Napkins available at: http://{args.host}:{args.port}/napkins/")

    if args.production:
        from waitress import serve
        serve(app, host=args.host, port=args.port, max_request_body_size=app.config["MAX_CONTENT_LENGTH"])
    else:
        app.run(host=args.host, port=args.port, debug=args.debug)
