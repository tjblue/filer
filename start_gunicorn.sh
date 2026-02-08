#!/bin/bash
# Start Filer with Gunicorn (Linux/Mac only)
#
# Usage:
#   ./start_gunicorn.sh [root_directory] [port] [host]
#
# Examples:
#   ./start_gunicorn.sh                    # Use defaults (current dir, port 5000, 0.0.0.0)
#   ./start_gunicorn.sh /path/to/files     # Serve specific directory
#   ./start_gunicorn.sh . 8080             # Use port 8080
#   ./start_gunicorn.sh . 8080 127.0.0.1   # Bind to localhost only

# Default values
ROOT_DIR="${1:-.}"
PORT="${2:-5000}"
HOST="${3:-0.0.0.0}"

# Export environment variables
export FILER_ROOT="$ROOT_DIR"
export FILER_PORT="$PORT"

# Display configuration
echo "========================================="
echo "Starting Filer with Gunicorn"
echo "========================================="
echo "Root Directory: $FILER_ROOT"
echo "Binding to: $HOST:$PORT"
echo "Workers: 2"
echo "Threads per worker: 2"
echo "========================================="
echo ""

# Start Gunicorn
gunicorn \
    --config gunicorn_config.py \
    --bind "$HOST:$PORT" \
    wsgi:application
