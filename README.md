# Filer - Directory-Based File Server

A modern web-based file management application with Quick Transfer and Trash features.

## Features

- **File Management**: Browse, upload, download, edit, rename, move, and delete files
- **Quick Transfer**: Share files and text snippets with expiration dates
- **Trash System**: Soft delete with restore capability
- **Search**: Find files by name and content (uses ripgrep if available)
- **Modern UI**: Clean, responsive interface with Tailwind CSS

## Installation

1. Clone or download this repository
2. Install dependencies:

```bash
pip install -r requirements.txt
```

## Running the Application

### Development Server

For development, use the built-in Flask server:

```bash
python server.py --root /path/to/files --port 5000 --host 127.0.0.1
```

**Options:**
- `--root, -r`: Root directory to serve (default: current directory)
- `--port, -p`: Port to run on (default: 5000)
- `--host, -H`: Host to bind to (default: 127.0.0.1)

### Production Server (Gunicorn)

For production deployment, use Gunicorn with 2 workers and 2 threads each:

**Linux/Mac:**
```bash
chmod +x start_gunicorn.sh
./start_gunicorn.sh [root_directory] [port] [host]
```

**Windows:**
```cmd
start_gunicorn.bat [root_directory] [port] [host]
```

**Examples:**
```bash
# Use defaults (current directory, port 5000, bind to 0.0.0.0)
./start_gunicorn.sh

# Serve specific directory
./start_gunicorn.sh /path/to/files

# Use custom port
./start_gunicorn.sh . 8080

# Bind to localhost only
./start_gunicorn.sh . 5000 127.0.0.1
```

**Manual Gunicorn command:**
```bash
export FILER_ROOT=/path/to/files
export FILER_PORT=5000
gunicorn --config gunicorn_config.py --bind 0.0.0.0:5000 wsgi:application
```

## Configuration

### Environment Variables

- `FILER_ROOT`: Root directory to serve (default: `.`)
- `FILER_PORT`: Port number (default: `5000`)

### Gunicorn Configuration

Edit `gunicorn_config.py` to customize:
- `workers`: Number of worker processes (default: 2)
- `threads`: Threads per worker (default: 2)
- `bind`: Host and port binding (default: 0.0.0.0:5000)
- `timeout`: Worker timeout in seconds (default: 30)
- `max_requests`: Restart workers after N requests (default: 1000)

### Application Configuration

Edit `app/config.py` for application settings:

**Quick Transfer:**
- `DEFAULT_EXPIRY_HOURS`: Default expiration time (default: 2 hours)
- `MAX_EXPIRY_DAYS`: Maximum expiration time (default: 7 days)
- `MAX_FILE_SIZE_MB`: Maximum upload size (default: 100 MB)

**Trash:**
- `TRASH_RETENTION_DAYS`: Auto-delete after N days (default: 14 days)

## Usage

### Main File Browser
- Navigate to `http://localhost:5000/`
- Browse directories, upload files, create folders
- Search files by name or content
- Edit text files directly in the browser
- Delete files (moves to trash)

### Quick Transfer
- Navigate to `http://localhost:5000/qt/`
- Upload files or share text snippets
- Get shareable links with automatic expiration
- Files expire after configured time (default: 2 hours)

### Trash Management
- Deleted files are moved to trash (not permanently deleted)
- Restore files from trash via the UI
- Trash items are auto-deleted after 14 days

## Security Notes

- The application includes path traversal protection
- File uploads are sanitized with secure filenames
- Configure firewall rules when binding to `0.0.0.0`
- Use HTTPS in production (configure reverse proxy)
- Consider authentication for public deployments

## Tech Stack

- **Backend**: Flask 3.0.0, Gunicorn 21.2.0
- **Frontend**: Vanilla JavaScript, Tailwind CSS, Lucide Icons
- **Python**: 3.8+

## License

[Add your license here]
