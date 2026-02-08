#!/bin/bash
# Optimized startup script for Filer

# Configuration
ROOT_DIR="${1:-.}"
PORT="${2:-5000}"
WORKERS="${3:-4}"

echo "Starting Filer with optimizations..."
echo "Root: $ROOT_DIR"
echo "Port: $PORT"
echo "Workers: $WORKERS"

# Check if gunicorn is available (production WSGI server)
if command -v gunicorn &> /dev/null; then
    echo "Using Gunicorn (production mode)"
    gunicorn \
        --bind 0.0.0.0:$PORT \
        --workers $WORKERS \
        --worker-class gevent \
        --worker-connections 1000 \
        --timeout 300 \
        --keep-alive 5 \
        --max-requests 10000 \
        --max-requests-jitter 1000 \
        server:app \
        --env ROOT_DIR="$ROOT_DIR"
else
    echo "Gunicorn not found, using Flask development server"
    echo "Install gunicorn for better performance: pip install gunicorn gevent"
    python3 server.py --root "$ROOT_DIR" --port $PORT
fi
