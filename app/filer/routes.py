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
import tempfile
import json
import hashlib
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
)
from werkzeug.exceptions import HTTPException
from PIL import Image

from app.utils import safe_path, get_file_info
from app.filesystem import validate_filename, filesystem_error, atomic_write_text, json_object, publish_file
from app.storage import save_json
from app.config import CHUNK_SIZE, MAX_FILE_SIZE_MB
from app.filer.search import search_with_ripgrep, search_with_python
from app.trash.service import trash_move_to_trash
from app.cache.thumb_cache import get_cached_thumb, save_thumb_cache, get_thumb_cache_path

# Create Blueprint
bp = Blueprint("filer", __name__)


def get_unique_path(dest):
    """Generate a unique filename by appending (n) if file exists."""
    if not os.path.lexists(dest):
        return dest

    stem = dest.stem
    suffix = dest.suffix
    parent = dest.parent
    counter = 1

    while True:
        new_name = f"{stem} ({counter}){suffix}"
        new_path = parent / new_name
        if not os.path.lexists(new_path):
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
                if item.name.startswith(".filer-"):
                    continue
                items.append(get_file_info(item, ROOT_DIR))
            except PermissionError, OSError:
                continue
    except OSError as error:
        message, status = filesystem_error(error)
        abort(status, message)

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
    except OSError as error:
        message, status = filesystem_error(error)
        abort(status, message)


@bp.route("/api/file", methods=["POST"])
def create_file():
    """Create a new file or folder."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = json_object(request)
    parent = safe_path(data.get("parent", ""))
    name = validate_filename(data.get("name", ""))
    is_folder = data.get("isFolder", False)
    if type(is_folder) is not bool:
        abort(400, "isFolder must be a boolean")

    new_path = parent / name

    if os.path.lexists(new_path):
        abort(409, "Already exists")

    try:
        if is_folder:
            new_path.mkdir(parents=True)
        else:
            with new_path.open("x"):
                pass
        return jsonify(
            {
                "success": True,
                "path": str(new_path.relative_to(ROOT_DIR)).replace("\\", "/"),
            }
        )
    except OSError as error:
        message, status = filesystem_error(error)
        abort(status, message)


@bp.route("/api/file", methods=["PUT"])
def update_file():
    """Update file content."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = json_object(request)
    path = safe_path(data.get("path", ""))
    content = data.get("content", "")

    if not path.exists():
        abort(404, "File not found")

    if path.is_dir():
        abort(400, "Cannot write to directory")

    try:
        atomic_write_text(path, content)
        return jsonify({"success": True})
    except OSError as error:
        message, status = filesystem_error(error)
        abort(status, message)


@bp.route("/api/file", methods=["DELETE"])
def delete_files():
    """Delete file(s) or folder(s) - moves to trash."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    data = json_object(request)
    paths = data.get("paths", [])

    if not paths:
        abort(400, "No paths provided")

    deleted = []
    errors = []

    if not isinstance(paths, list):
        abort(400, "paths must be a list")
    for p in paths:
        try:
            path = safe_path(p)
            if not path.exists():
                abort(404, "Not found")
            if path == ROOT_DIR:
                abort(400, "Cannot delete the root directory")
            result = trash_move_to_trash(path.relative_to(ROOT_DIR).as_posix(), ROOT_DIR)
            if result:
                deleted.append(p)
            else:
                errors.append({"path": p, "error": "Failed to move to trash"})
        except HTTPException as error:
            errors.append({"path": p, "error": error.description})
        except OSError as error:
            errors.append({"path": p, "error": filesystem_error(error)[0]})

    return jsonify({"deleted": deleted, "errors": errors})


@bp.route("/api/move", methods=["POST"])
def move_files():
    """Move or rename file(s)/folder(s)."""
    data = json_object(request)
    items = data.get("items", [])  # List of {source, destination}

    if not items:
        abort(400, "No items provided")

    moved = []
    errors = []

    if not isinstance(items, list):
        abort(400, "items must be a list")
    for item in items:
        source_name = item.get("source", "") if isinstance(item, dict) else None
        try:
            if not isinstance(item, dict):
                abort(400, "Invalid move item")
            source = safe_path(source_name)
            destination_name = item.get("destination", "")
            if not isinstance(destination_name, str) or not destination_name:
                abort(400, "Invalid destination")
            for component in destination_name.replace("\\", "/").strip("/").split("/"):
                validate_filename(component)
            destination = safe_path(destination_name)
            if source == current_app.config["ROOT_DIR"]:
                abort(400, "Cannot move the root directory")
            if source == destination or (source.is_dir() and destination.is_relative_to(source)):
                abort(400, "Cannot move a folder into itself or a descendant")
            if not source.exists():
                abort(404, "Source not found")
            if os.path.lexists(destination):
                abort(409, "Destination exists")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
            moved.append({"source": source_name, "destination": destination_name})
        except HTTPException as error:
            errors.append({"source": source_name, "error": error.description})
        except OSError as error:
            errors.append({"source": source_name, "error": filesystem_error(error)[0]})

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
            errors.append({"name": "", "error": "Missing filename"})
            continue
        temporary = None
        try:
            filename = validate_filename(file.filename.replace("\\", "/").rsplit("/", 1)[-1])
            fd, temporary = tempfile.mkstemp(prefix=".filer-small-", suffix=".part", dir=parent)
            size = 0
            with os.fdopen(fd, "wb") as handle:
                while block := file.stream.read(1024 * 1024):
                    size += len(block)
                    if size > MAX_FILE_SIZE_MB * 1024 * 1024:
                        abort(413, "File too large")
                    handle.write(block)
                handle.flush()
                os.fsync(handle.fileno())
            dest = publish_file(Path(temporary), parent / filename)
            uploaded.append(dest.relative_to(ROOT_DIR).as_posix())
        except HTTPException as error:
            errors.append({"name": file.filename, "error": error.description})
        except OSError as error:
            errors.append({"name": file.filename, "error": filesystem_error(error)[0]})
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)

    return jsonify({"uploaded": uploaded, "errors": errors})


# Disk checkpoints survive restarts; this cache avoids re-reading them per chunk.
_active_uploads = {}
_uploads_lock = threading.Lock()
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _session_dir():
    folder = Path(current_app.config["DATA_DIR"]) / "upload_sessions"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _save_upload(uid, info):
    root = info["root"]
    save_json(_session_dir() / f"{uid}.json", {
        "root": str(root), "path": info["path"].relative_to(root).as_posix(),
        "destination": info["destination"].relative_to(root).as_posix(),
        "size": info["size"], "chunk_size": info["chunk_size"],
        "received": sorted(info["received"]), "updated": info["updated"].isoformat(),
        "completed": info.get("completed"), "digests": info.get("digests", {}),
        "publication": info.get("publication"),
    })


def _read_upload(uid):
    filename = _session_dir() / f"{uid}.json"
    try:
        data = json.loads(filename.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return None
    root = current_app.config["ROOT_DIR"]
    if Path(data["root"]).resolve() != root:
        return None
    path = (root / data["path"]).resolve()
    destination = (root / data["destination"]).resolve()
    if (not path.is_relative_to(root) or not destination.is_relative_to(root)
            or not path.name.startswith('.filer-') or not path.name.endswith('.part')):
        abort(400, "Invalid upload checkpoint")
    return {"path": path, "destination": destination, "root": root,
            "size": data["size"], "chunk_size": data["chunk_size"],
            "received": set(data["received"]), "updated": datetime.fromisoformat(data["updated"]),
            "completed": data.get("completed"), "digests": data.get("digests", {}),
            "publication": data.get("publication")}


def _cleanup_stale_uploads():
    """Clean expired disk checkpoints as well as in-memory sessions."""
    cutoff = datetime.now() - timedelta(hours=24)
    with _uploads_lock:
        ids = set(_active_uploads) | {path.stem for path in _session_dir().glob('*.json') if _UUID_RE.fullmatch(path.stem)}
        for uid in ids:
            try:
                info = _active_uploads.get(uid) or _read_upload(uid)
                if info and info["root"] == current_app.config["ROOT_DIR"] and info["updated"] < cutoff:
                    info["path"].unlink(missing_ok=True)
                    (_session_dir() / f"{uid}.json").unlink(missing_ok=True)
                    _active_uploads.pop(uid, None)
            except (OSError, ValueError, KeyError):
                current_app.logger.warning("Could not clean an expired upload", exc_info=True)


def _recover_publication(uid, info):
    """Recover a rename whose completion receipt could not be saved."""
    if info.get("completed") or not info.get("publication") or info["path"].exists():
        return
    candidate = safe_path(info["publication"])
    if not candidate.is_file() or candidate.stat().st_size != info["size"]:
        abort(409, "Upload staging file is missing; destination could not be verified")
    with candidate.open('rb') as handle:
        index = 0
        while block := handle.read(info["chunk_size"]):
            if hashlib.sha256(block).hexdigest() != info.get("digests", {}).get(str(index)):
                abort(409, "Upload destination changed; refusing to report success")
            index += 1
    info["completed"] = info["publication"]
    info["updated"] = datetime.now()
    _save_upload(uid, info)


def _get_upload(upload_id):
    """Called while holding _uploads_lock; recover missing memory state from disk."""
    if not isinstance(upload_id, str) or not _UUID_RE.fullmatch(upload_id):
        abort(400, "Invalid uploadId")
    info = _active_uploads.get(upload_id)
    if info is None:
        info = _read_upload(upload_id)
        if info is not None:
            _active_uploads[upload_id] = info
    if not info or info["root"] != current_app.config["ROOT_DIR"]:
        abort(404, "Upload session not found")
    if info["updated"] < datetime.now() - timedelta(hours=24):
        abort(410, "Upload session expired; select the file again to restart")
    _recover_publication(upload_id, info)
    return info


@bp.route("/api/upload/status", methods=["POST"])
def upload_status():
    with _uploads_lock:
        info = _get_upload(json_object(request).get("uploadId", ""))
        return jsonify({"received": sorted(info["received"]), "chunkSize": info["chunk_size"],
                        "fileSize": info["size"], "completed": info.get("completed")})


@bp.route("/api/upload/init", methods=["POST"])
def upload_init():
    """Stage an upload separately so starting or cancelling cannot destroy files."""
    data = json_object(request)
    file_name = validate_filename(data.get("fileName", ""))
    file_size = data.get("fileSize")
    if type(file_size) is not int or file_size < 0:
        abort(400, "fileSize must be a non-negative integer")
    if file_size > MAX_FILE_SIZE_MB * 1024 * 1024:
        abort(413, "File too large")
    parent = safe_path(data.get("destPath", ""))
    if not parent.is_dir():
        abort(400, "Invalid upload directory")
    _cleanup_stale_uploads()
    upload_id = str(uuid.uuid4())
    # A sibling staging file allows atomic publication on the same filesystem.
    fd, temporary = tempfile.mkstemp(prefix=".filer-", suffix=".part", dir=parent)
    os.close(fd)
    info = {"path": Path(temporary), "destination": parent / file_name,
            "root": current_app.config["ROOT_DIR"], "size": file_size,
            "chunk_size": CHUNK_SIZE, "received": set(), "digests": {}, "updated": datetime.now()}
    try:
        with _uploads_lock:
            _save_upload(upload_id, info)
            _active_uploads[upload_id] = info
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise

    return jsonify({"uploadId": upload_id, "chunkSize": CHUNK_SIZE})


@bp.route("/api/upload/chunk", methods=["POST"])
def upload_chunk():
    upload_id = request.form.get("uploadId", "")
    try:
        chunk_idx = int(request.form.get("chunkIndex", ""))
    except (ValueError, TypeError):
        abort(400, "Invalid chunkIndex")
    chunk_file = request.files.get("chunk")
    if chunk_file is None:
        abort(400, "No chunk data")
    # Read at most one chunk plus a sentinel byte, even for oversized requests.
    with _uploads_lock:
        info = _get_upload(upload_id)
        if info.get("completed"):
            abort(409, "Upload already completed")
        offset = chunk_idx * info["chunk_size"]
        if chunk_idx < 0 or offset >= info["size"]:
            abort(400, "Chunk index out of range")
        expected = min(info["chunk_size"], info["size"] - offset)
        data = chunk_file.read(expected + 1)
        if len(data) != expected:
            abort(400, "Invalid chunk length")
        with info["path"].open("r+b") as handle:
            handle.seek(offset)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        info.setdefault("digests", {})[str(chunk_idx)] = hashlib.sha256(data).hexdigest()
        info["received"].add(chunk_idx)
        info["updated"] = datetime.now()
        _save_upload(upload_id, info)
    return jsonify({"uploadId": upload_id, "chunkIndex": chunk_idx, "received": True})


@bp.route("/api/upload/complete", methods=["POST"])
def upload_complete():
    upload_id = json_object(request).get("uploadId", "")
    with _uploads_lock:
        info = _get_upload(upload_id)
        if info.get("completed"):
            return jsonify({"success": True, "path": info["completed"]})
        count = (info["size"] + info["chunk_size"] - 1) // info["chunk_size"]
        if len(info["received"]) != count:
            abort(409, "Upload is incomplete")
        if info["path"].stat().st_size != info["size"]:
            abort(409, "Upload size mismatch")
        root = info["root"]
        # Revalidate in case a directory was replaced while uploading.
        destination = safe_path(str(info["destination"].relative_to(root)))
        # Upgrade older checkpoints before recording publication intent.
        if len(info.get("digests", {})) != count:
            with info["path"].open('rb') as handle:
                info["digests"] = {str(index): hashlib.sha256(handle.read(info["chunk_size"])).hexdigest()
                                   for index in range(count)}
        while True:
            candidate = get_unique_path(destination)
            info["publication"] = candidate.relative_to(root).as_posix()
            _save_upload(upload_id, info)
            try:
                if os.name == 'nt':
                    os.rename(info["path"], candidate)
                else:
                    os.link(info["path"], candidate)
                    info["path"].unlink()
                destination = candidate
                break
            except FileExistsError:
                continue
        info["completed"] = destination.relative_to(root).as_posix()
        info["updated"] = datetime.now()
        _save_upload(upload_id, info)
    return jsonify({"success": True, "path": info["completed"]})


@bp.route("/api/upload/cancel", methods=["POST"])
def upload_cancel():
    upload_id = json_object(request).get("uploadId", "")
    if not isinstance(upload_id, str) or not _UUID_RE.fullmatch(upload_id):
        abort(400, "Invalid uploadId")
    with _uploads_lock:
        try:
            info = _get_upload(upload_id)
        except HTTPException as error:
            if error.code != 404:
                raise
            return jsonify({"success": True})
        info["path"].unlink(missing_ok=True)
        (_session_dir() / f"{upload_id}.json").unlink(missing_ok=True)
        _active_uploads.pop(upload_id, None)
    return jsonify({"success": True})


@bp.route("/api/zip")
def download_zip():
    """Download selected files/folders as a zip archive."""
    ROOT_DIR = current_app.config["ROOT_DIR"]
    paths = request.args.getlist("paths")

    if not paths:
        abort(400, "No paths provided")

    archive_dir = Path(current_app.config["DATA_DIR"]) / "archives"
    archive_dir.mkdir(parents=True, exist_ok=True)
    buf = tempfile.TemporaryFile(mode="w+b", dir=archive_dir)
    added = set()
    try:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zipf:
            def add_path(path):
                # Use root-relative names so files with the same basename stay distinct.
                resolved = path.resolve()
                if not resolved.is_relative_to(ROOT_DIR):
                    abort(403, "Archive path is outside the root")
                arcname = path.relative_to(ROOT_DIR).as_posix()
                if arcname == "." or arcname in added:
                    return
                added.add(arcname)
                zipf.write(path, arcname)

            for p in paths:
                full_path = safe_path(p)
                if not full_path.exists():
                    abort(404, f"Not found: {p}")
                if full_path.is_file():
                    add_path(full_path)
                elif full_path.is_dir():
                    add_path(full_path)
                    def walk_error(error):
                        raise error
                    for root, dirs, filenames in os.walk(full_path, onerror=walk_error):
                        for dirname in dirs:
                            add_path(Path(root) / dirname)
                        for fname in filenames:
                            add_path(Path(root) / fname)

        length = buf.tell()
        buf.seek(0)
        response = send_file(buf, mimetype="application/zip", as_attachment=True, download_name="download.zip", conditional=False)
        response.headers["Content-Length"] = length
        response.call_on_close(buf.close)
        return response
    except BaseException:
        buf.close()
        raise


@bp.route("/api/download")
def download_file():
    """Download a file."""
    path = safe_path(request.args.get("path", ""))

    if not path.exists():
        abort(404, "File not found")

    if path.is_dir():
        abort(400, "Cannot download directory")

    response = send_file(path, as_attachment=True, download_name=path.name)
    # send_file sets the correct length for both full and ranged responses.
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
    try:
        size = int(request.args.get("size", 150))
    except (TypeError, ValueError):
        abort(400, "Invalid thumbnail size")
    if not 1 <= size <= 2048:
        abort(400, "Thumbnail size must be between 1 and 2048")

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
            # JPEG cannot represent alpha or palette modes. Composite transparent
            # pixels on white so transparent PNGs/GIFs also produce usable previews.
            rgba = img.convert("RGBA")
            preview = Image.new("RGB", rgba.size, "white")
            preview.paste(rgba, mask=rgba.getchannel("A"))
            preview.save(buf, format="JPEG", quality=75, optimize=True)
            buf.seek(0)
            thumb_data = buf.getvalue()

            # Save to cache in background
            threading.Thread(
                target=save_thumb_cache, args=(path, size, thumb_data, get_thumb_cache_path(path, size))
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
    try:
        max_results = int(request.args.get("limit", 100))
    except (TypeError, ValueError):
        abort(400, "Invalid result limit")
    if not 1 <= max_results <= 500:
        abort(400, "Result limit must be between 1 and 500")

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
    data = json_object(request)
    path = safe_path(data.get("path", ""))
    new_name = validate_filename(data.get("newName", ""))

    if not path.exists():
        abort(404, "Not found")

    if path == ROOT_DIR:
        abort(400, "Cannot rename the root directory")

    new_path = path.parent / new_name

    if os.path.lexists(new_path):
        abort(409, "Name already exists")

    try:
        path.rename(new_path)
        return jsonify(
            {
                "success": True,
                "path": str(new_path.relative_to(ROOT_DIR)).replace("\\", "/"),
            }
        )
    except OSError as error:
        message, status = filesystem_error(error)
        abort(status, message)
