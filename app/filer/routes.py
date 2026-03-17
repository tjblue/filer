"""
Filer HTTP routes - file management operations.
"""

import os
import re
import shutil
import uuid
import zipfile
import io
import threading
from pathlib import Path
from datetime import datetime, timedelta
from flask import (
    Blueprint,
    render_template,
    request,
    jsonify,
    send_file,
    abort,
    current_app,
    Response,
)
from werkzeug.utils import secure_filename
from PIL import Image

from app.utils import safe_path, get_file_info
from app.config import CHUNK_SIZE, MAX_FILE_SIZE_MB
from app.filer.search import search_with_ripgrep, search_with_python
from app.trash.service import trash_move_to_trash
from app.cache.thumb_cache import get_cached_thumb, save_thumb_cache

# Create Blueprint
bp = Blueprint("filer", __name__)


def get_unique_path(dest):
    """Generate a unique filename by appending (n) if file exists."""
    if not dest.exists():
        return dest

    stem = dest.stem
    suffix = dest.suffix
    parent = dest.parent
    counter = 1

    while True:
        new_name = f"{stem} ({counter}){suffix}"
        new_path = parent / new_name
        if not new_path.exists():
            return new_path
        counter += 1


@bp.route("/")
@bp.route("/<path:filepath>")
def index(filepath=""):
    """Serve the main UI for any path."""
    return render_template("index.html")


@bp.route("/api/files")
def list_files():
    """List directory contents."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    path = safe_path(request.args.get("path", ""))

    if not path.exists():
        abort(404, "Directory not found")

    if not path.is_dir():
        abort(400, "Not a directory")

    items = []
    try:
        for item in sorted(
            path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())
        ):
            try:
                items.append(get_file_info(item, ROOT_DIR))
            except PermissionError, OSError:
                continue
    except PermissionError:
        abort(403, "Permission denied")

    current_path = str(path.relative_to(ROOT_DIR)).replace("\\", "/")
    if current_path == ".":
        current_path = ""

    return jsonify({"path": current_path, "items": items})


@bp.route("/api/file", methods=["GET"])
def get_file():
    """Get file content for editing."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    path = safe_path(request.args.get("path", ""))

    if not path.exists():
        abort(404, "File not found")

    if path.is_dir():
        abort(400, "Cannot read directory")

    rel_path = str(path.relative_to(ROOT_DIR)).replace("\\", "/")
    file_info = get_file_info(path, ROOT_DIR)

    try:
        content = path.read_text(encoding="utf-8")
        return jsonify(
            {
                "content": content,
                "path": rel_path,
                "name": path.name,
                "size": file_info["size"],
                "modified": file_info["modified"],
                "isBinary": False,
            }
        )
    except UnicodeDecodeError:
        return jsonify(
            {
                "content": None,
                "path": rel_path,
                "name": path.name,
                "size": file_info["size"],
                "modified": file_info["modified"],
                "isBinary": True,
            }
        )
    except PermissionError:
        abort(403, "Permission denied")


@bp.route("/api/file", methods=["POST"])
def create_file():
    """Create a new file or folder."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = request.get_json()
    parent = safe_path(data.get("parent", ""))
    name = data.get("name", "").strip()
    is_folder = data.get("isFolder", False)

    if not name or "/" in name or "\\" in name or ".." in name:
        abort(400, "Invalid name")

    new_path = parent / name

    if new_path.exists():
        abort(409, "Already exists")

    try:
        if is_folder:
            new_path.mkdir(parents=True)
        else:
            new_path.touch()
        return jsonify(
            {
                "success": True,
                "path": str(new_path.relative_to(ROOT_DIR)).replace("\\", "/"),
            }
        )
    except PermissionError:
        abort(403, "Permission denied")


@bp.route("/api/file", methods=["PUT"])
def update_file():
    """Update file content."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = request.get_json()
    path = safe_path(data.get("path", ""))
    content = data.get("content", "")

    if not path.exists():
        abort(404, "File not found")

    if path.is_dir():
        abort(400, "Cannot write to directory")

    try:
        path.write_text(content, encoding="utf-8")
        return jsonify({"success": True})
    except PermissionError:
        abort(403, "Permission denied")


@bp.route("/api/file", methods=["DELETE"])
def delete_files():
    """Delete file(s) or folder(s) - moves to trash."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = request.get_json()
    paths = data.get("paths", [])

    if not paths:
        abort(400, "No paths provided")

    deleted = []
    errors = []

    for p in paths:
        path = safe_path(p)
        if not path.exists():
            errors.append({"path": p, "error": "Not found"})
            continue

        try:
            result = trash_move_to_trash(p, ROOT_DIR)
            if result:
                deleted.append(p)
            else:
                errors.append({"path": p, "error": "Failed to move to trash"})
        except PermissionError:
            errors.append({"path": p, "error": "Permission denied"})
        except Exception as e:
            errors.append({"path": p, "error": str(e)})

    return jsonify({"deleted": deleted, "errors": errors})


@bp.route("/api/move", methods=["POST"])
def move_files():
    """Move or rename file(s)/folder(s)."""
    data = request.get_json()
    items = data.get("items", [])  # List of {source, destination}

    if not items:
        abort(400, "No items provided")

    moved = []
    errors = []

    for item in items:
        source = safe_path(item.get("source", ""))
        dest_path = item.get("destination", "").strip()

        if not dest_path or ".." in dest_path:
            errors.append(
                {"source": item.get("source"), "error": "Invalid destination"}
            )
            continue

        destination = safe_path(dest_path)

        if not source.exists():
            errors.append({"source": item.get("source"), "error": "Source not found"})
            continue

        if destination.exists():
            errors.append({"source": item.get("source"), "error": "Destination exists"})
            continue

        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
            moved.append({"source": item.get("source"), "destination": dest_path})
        except PermissionError:
            errors.append({"source": item.get("source"), "error": "Permission denied"})

    return jsonify({"moved": moved, "errors": errors})


@bp.route("/api/upload", methods=["POST"])
def upload_files():
    """Upload file(s)."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    parent = safe_path(request.form.get("path", ""))

    if not parent.is_dir():
        abort(400, "Invalid upload directory")

    uploaded = []
    errors = []

    for file in request.files.getlist("files"):
        if not file.filename:
            continue

        # Sanitize filename
        filename = os.path.basename(file.filename)
        if not filename or ".." in filename:
            errors.append({"name": file.filename, "error": "Invalid filename"})
            continue

        dest = parent / filename

        # Auto-rename if file exists (like Google Drive's "Keep both")
        if dest.exists():
            dest = get_unique_path(dest)

        try:
            file.save(str(dest))
            uploaded.append(str(dest.relative_to(ROOT_DIR)).replace("\\", "/"))
        except PermissionError:
            errors.append({"name": filename, "error": "Permission denied"})

    return jsonify({"uploaded": uploaded, "errors": errors})


# Registry of active chunked uploads: upload_id -> { path, size, lock }
_active_uploads = {}
_uploads_lock = threading.Lock()

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _cleanup_stale_uploads():
    """Remove upload entries and partial files older than 24 hours."""
    cutoff = datetime.now() - timedelta(hours=24)
    with _uploads_lock:
        stale = []
        for uid, info in _active_uploads.items():
            try:
                mtime = datetime.fromtimestamp(info["path"].stat().st_mtime)
                if mtime < cutoff:
                    stale.append(uid)
            except OSError:
                stale.append(uid)
        for uid in stale:
            info = _active_uploads.pop(uid)
            try:
                info["path"].unlink(missing_ok=True)
            except OSError:
                pass


@bp.route("/api/upload/init", methods=["POST"])
def upload_init():
    """Initialize a chunked upload — pre-allocates the destination file."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = request.get_json()
    file_name = data.get("fileName", "").strip()
    file_size = data.get("fileSize", 0)
    dest_path = data.get("destPath", "")

    if not file_name:
        abort(400, "Missing fileName")

    # Sanitize filename
    file_name = os.path.basename(file_name)
    if not file_name or ".." in file_name:
        abort(400, "Invalid filename")

    # Validate destination
    parent = safe_path(dest_path)
    if not parent.is_dir():
        abort(400, "Invalid upload directory")

    # Enforce file size limit
    max_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
    if file_size > max_bytes:
        abort(413, f"File too large. Maximum size is {MAX_FILE_SIZE_MB} MB")

    _cleanup_stale_uploads()

    upload_id = str(uuid.uuid4())
    dest = parent / file_name

    # Pre-allocate the file
    try:
        with open(str(dest), "wb") as f:
            f.seek(file_size - 1)
            f.write(b"\0")
    except OSError as e:
        abort(500, f"Failed to create file: {e}")

    with _uploads_lock:
        _active_uploads[upload_id] = {
            "path": dest,
            "size": file_size,
            "lock": threading.Lock(),
        }

    return jsonify({"uploadId": upload_id, "chunkSize": CHUNK_SIZE})


@bp.route("/api/upload/chunk", methods=["POST"])
def upload_chunk():
    """Write a chunk directly into the destination file at the correct offset."""
    upload_id = request.form.get("uploadId", "")
    chunk_index = request.form.get("chunkIndex", "")

    if not _UUID_RE.match(upload_id):
        abort(400, "Invalid uploadId")

    try:
        chunk_idx = int(chunk_index)
        if chunk_idx < 0:
            raise ValueError
    except ValueError, TypeError:
        abort(400, "Invalid chunkIndex")

    with _uploads_lock:
        info = _active_uploads.get(upload_id)
    if not info:
        abort(404, "Upload session not found")

    chunk_file = request.files.get("chunk")
    if not chunk_file:
        abort(400, "No chunk data")

    data = chunk_file.read()
    offset = chunk_idx * CHUNK_SIZE

    with info["lock"]:
        try:
            with open(str(info["path"]), "r+b") as f:
                f.seek(offset)
                f.write(data)
        except OSError as e:
            abort(500, f"Failed to write chunk: {e}")

    return jsonify({"uploadId": upload_id, "chunkIndex": chunk_idx, "received": True})


@bp.route("/api/upload/complete", methods=["POST"])
def upload_complete():
    """Finalize a chunked upload — file is already assembled."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = request.get_json()
    upload_id = data.get("uploadId", "")

    if not _UUID_RE.match(upload_id):
        abort(400, "Invalid uploadId")

    with _uploads_lock:
        info = _active_uploads.pop(upload_id, None)
    if not info:
        abort(404, "Upload session not found")

    # Verify final size
    try:
        actual = info["path"].stat().st_size
        if actual != info["size"]:
            abort(500, f"Size mismatch: expected {info['size']}, got {actual}")
    except OSError as e:
        abort(500, f"Failed to verify file: {e}")

    rel_path = str(info["path"].relative_to(ROOT_DIR)).replace("\\", "/")
    return jsonify({"success": True, "path": rel_path})


@bp.route("/api/upload/cancel", methods=["POST"])
def upload_cancel():
    """Cancel an in-progress chunked upload and delete the partial file."""
    data = request.get_json()
    upload_id = data.get("uploadId", "")

    if not _UUID_RE.match(upload_id):
        abort(400, "Invalid uploadId")

    with _uploads_lock:
        info = _active_uploads.pop(upload_id, None)
    if info:
        try:
            info["path"].unlink(missing_ok=True)
        except OSError:
            pass

    return jsonify({"success": True})


@bp.route("/api/zip")
def download_zip():
    """Download selected files/folders as a zip archive."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    paths = request.args.getlist("paths")

    if not paths:
        abort(400, "No paths provided")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zipf:
        for p in paths:
            full_path = safe_path(p)
            if not full_path.exists():
                abort(404, f"Not found: {p}")

            if full_path.is_file():
                arcname = full_path.name
                zipf.write(full_path, arcname)
            elif full_path.is_dir():
                base_name = full_path.name
                for root, dirs, filenames in os.walk(full_path):
                    for fname in filenames:
                        file_path = Path(root) / fname
                        arcname = (
                            base_name
                            + "/"
                            + str(file_path.relative_to(full_path)).replace("\\", "/")
                        )
                        zipf.write(file_path, arcname)

    buf.seek(0)
    data = buf.getvalue()
    return Response(
        data,
        mimetype="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="download.zip"',
            "Content-Length": len(data),
        },
    )


@bp.route("/api/download")
def download_file():
    """Download a file."""
    path = safe_path(request.args.get("path", ""))

    if not path.exists():
        abort(404, "File not found")

    if path.is_dir():
        abort(400, "Cannot download directory")

    response = send_file(path, as_attachment=True, download_name=path.name)
    # Ensure Content-Length is set for download progress tracking
    try:
        file_size = path.stat().st_size
        response.headers["Content-Length"] = file_size
    except OSError:
        pass
    response.headers["Accept-Ranges"] = "bytes"
    return response


@bp.route("/api/view")
def view_file_inline():
    """View a file inline (for PDF viewer, images, etc.)."""
    path = safe_path(request.args.get("path", ""))

    if not path.exists():
        abort(404, "File not found")

    if path.is_dir():
        abort(400, "Cannot view directory")

    return send_file(path, as_attachment=False)


@bp.route("/api/thumb")
def thumb_file():
    """Generate a thumbnail for an image file."""
    path = safe_path(request.args.get("path", ""))
    size = int(request.args.get("size", 150))

    if not path.exists():
        abort(404, "File not found")

    if path.is_dir():
        abort(400, "Cannot view directory")

    ext = path.suffix.lower()
    if ext not in [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]:
        abort(400, "Not an image file")

    # Check cache first
    cached_data = get_cached_thumb(path, size)
    if cached_data:
        buf = io.BytesIO(cached_data)
        return send_file(buf, mimetype="image/jpeg")

    try:
        with Image.open(path) as img:
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=75, optimize=True)
            buf.seek(0)
            thumb_data = buf.getvalue()

            # Save to cache in background
            threading.Thread(
                target=save_thumb_cache, args=(path, size, thumb_data)
            ).start()

            return send_file(buf, mimetype="image/jpeg")
    except Exception as e:
        abort(500, f"Error generating thumbnail: {e}")


@bp.route("/api/search")
def search_files():
    """Search for files by name and/or content."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    query = request.args.get("q", "").strip()
    search_path = safe_path(request.args.get("path", ""))
    max_results = min(int(request.args.get("limit", 100)), 500)

    if not query:
        return jsonify({"results": []})

    if not search_path.is_dir():
        abort(400, "Invalid search path")

    # Try ripgrep first, fall back to Python
    results = search_with_ripgrep(query, search_path, max_results)
    if results is None:
        results = search_with_python(query, search_path, max_results)

    # Also search directory names (always use Python for this)
    query_lower = query.lower()
    try:
        for root, dirs, _ in os.walk(search_path):
            if len(results) >= max_results:
                break
            for dirname in dirs:
                if dirname.startswith("."):
                    continue
                if query_lower in dirname.lower():
                    dirpath = Path(root) / dirname
                    rel_path = str(dirpath.relative_to(ROOT_DIR)).replace("\\", "/")
                    stat = dirpath.stat()
                    results.append(
                        {
                            "name": dirname,
                            "path": rel_path,
                            "isDirectory": True,
                            "size": None,
                            "modified": datetime.fromtimestamp(
                                stat.st_mtime
                            ).isoformat(),
                            "nameMatch": True,
                            "contentMatches": [],
                        }
                    )
                    if len(results) >= max_results:
                        break
    except PermissionError:
        pass

    # Sort: directories first, then by name match, then alphabetically
    results.sort(
        key=lambda x: (not x["isDirectory"], not x["nameMatch"], x["name"].lower())
    )

    return jsonify(
        {
            "query": query,
            "results": results[:max_results],
            "truncated": len(results) >= max_results,
        }
    )


@bp.route("/api/folders")
def list_folders():
    """Get folder tree structure for move dialog."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    exclude = request.args.getlist("exclude")  # Paths to exclude

    def get_folder_tree(path: Path, rel_prefix: str = "") -> list:
        folders = []
        try:
            for item in sorted(path.iterdir(), key=lambda x: x.name.lower()):
                if item.is_dir() and not item.name.startswith("."):
                    rel_path = f"{rel_prefix}/{item.name}".lstrip("/")
                    # Skip excluded paths
                    if rel_path in exclude:
                        continue
                    folders.append(
                        {
                            "name": item.name,
                            "path": rel_path,
                            "children": get_folder_tree(item, rel_path),
                        }
                    )
        except PermissionError:
            pass
        return folders

    tree = get_folder_tree(ROOT_DIR)
    return jsonify({"folders": tree})


@bp.route("/api/rename", methods=["POST"])
def rename_file():
    """Rename a file or folder."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = request.get_json()
    path = safe_path(data.get("path", ""))
    new_name = data.get("newName", "").strip()

    if not new_name or "/" in new_name or "\\" in new_name or ".." in new_name:
        abort(400, "Invalid name")

    if not path.exists():
        abort(404, "Not found")

    new_path = path.parent / new_name

    if new_path.exists():
        abort(409, "Name already exists")

    try:
        path.rename(new_path)
        return jsonify(
            {
                "success": True,
                "path": str(new_path.relative_to(ROOT_DIR)).replace("\\", "/"),
            }
        )
    except PermissionError:
        abort(403, "Permission denied")
