"""
Quick Transfer HTTP routes - file and text snippet sharing.
"""

import os
import tempfile
from pathlib import Path
from datetime import datetime, timedelta
from flask import Blueprint, render_template, request, jsonify, send_file, url_for, abort
from werkzeug.utils import secure_filename
from app.filesystem import json_object

from app.config import (
    QT_UPLOAD_FOLDER,
    DEFAULT_EXPIRY_HOURS,
    MAX_EXPIRY_DAYS,
    MAX_FILE_SIZE_MB
)
from app.quicktransfer.service import (
    qt_metadata_lock,
    qt_generate_id,
    qt_load_metadata,
    qt_save_metadata,
    qt_get_item,
    qt_delete_item,
    qt_get_local_ip,
    qt_format_size,
    qt_format_time_remaining,
    qt_is_expired
)

# Create Blueprint
bp = Blueprint('quicktransfer', __name__, url_prefix='/napkins')


@bp.route('/')
def napkins():
    """Napkins UI"""
    #port = request.host.split(':')[-1] if ':' in request.host else '5000'
    #network_ip = f"http://{qt_get_local_ip()}:{port}"
    return render_template('napkins.html', max_file_size_mb=MAX_FILE_SIZE_MB)


def expiry_hours(value):
    try:
        if isinstance(value, bool) or isinstance(value, float):
            raise ValueError
        hours = int(value)
    except (TypeError, ValueError):
        abort(400, "Expiry must be a whole number of hours")
    if hours < 1:
        abort(400, "Expiry must be at least one hour")
    return min(hours, MAX_EXPIRY_DAYS * 24)


@bp.route('/upload', methods=['POST'])
def qt_upload_file():
    """Handle file upload"""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    # Get expiry time
    hours = expiry_hours(request.form.get('expiry_hours', DEFAULT_EXPIRY_HOURS))

    # Generate ID and filename
    item_id = qt_generate_id()
    original_name = secure_filename(file.filename) or 'unnamed'
    stored_name = f"{item_id}_{original_name}"
    file_path = os.path.join(QT_UPLOAD_FOLDER, stored_name)

    folder = Path(QT_UPLOAD_FOLDER)
    folder.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.upload-', dir=folder)
    published = False
    try:
        file_size = 0
        with os.fdopen(fd, 'wb') as handle:
            while block := file.stream.read(1024 * 1024):
                file_size += len(block)
                if file_size > MAX_FILE_SIZE_MB * 1024 * 1024:
                    abort(413, "File too large")
                handle.write(block)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, file_path)
        published = True
        now = datetime.now()
        expires_at = now + timedelta(hours=hours)
        with qt_metadata_lock.transaction():
            metadata = qt_load_metadata()
            metadata['items'][item_id] = {
                'id': item_id, 'type': 'file', 'original_name': original_name,
                'stored_name': stored_name, 'size_bytes': file_size,
                'created_at': now.isoformat(), 'expires_at': expires_at.isoformat()
            }
            qt_save_metadata(metadata)
    except BaseException:
        if published:
            Path(file_path).unlink(missing_ok=True)
        raise
    finally:
        Path(temporary).unlink(missing_ok=True)

    return jsonify({
        'success': True,
        'id': item_id,
        'download_url': url_for('quicktransfer.qt_download', item_id=item_id),
        'expires_at': expires_at.isoformat()
    })


@bp.route('/text', methods=['POST'])
@qt_metadata_lock
def qt_upload_text():
    """Handle text snippet upload"""
    data = json_object(request)
    if not data or not data.get('content'):
        return jsonify({'error': 'No content provided'}), 400

    content = data['content']
    if not isinstance(content, str) or not isinstance(data.get('title', ''), str):
        abort(400, 'Title and content must be text')
    title = data.get('title', '').strip() or 'Untitled'
    hours = expiry_hours(data.get('expiry_hours', DEFAULT_EXPIRY_HOURS))

    item_id = qt_generate_id()
    now = datetime.now()
    expires_at = now + timedelta(hours=hours)

    metadata = qt_load_metadata()
    metadata['items'][item_id] = {
        'id': item_id,
        'type': 'text',
        'title': title,
        'content': content,
        'size_bytes': len(content.encode('utf-8')),
        'created_at': now.isoformat(),
        'expires_at': expires_at.isoformat()
    }
    qt_save_metadata(metadata)

    return jsonify({
        'success': True,
        'id': item_id,
        'view_url': url_for('quicktransfer.qt_view_text', item_id=item_id),
        'raw_url': url_for('quicktransfer.qt_raw_text', item_id=item_id),
        'expires_at': expires_at.isoformat()
    })


@bp.route('/download/<item_id>')
def qt_download(item_id):
    """Download a file"""
    item = qt_get_item(item_id)
    if not item or item['type'] != 'file':
        return "Not found", 404

    file_path = os.path.join(QT_UPLOAD_FOLDER, item['stored_name'])
    if not os.path.exists(file_path):
        return "File not found", 404

    return send_file(
        os.path.abspath(file_path),
        as_attachment=True,
        download_name=item['original_name']
    )


@bp.route('/view/<item_id>')
def qt_view_text(item_id):
    """View a text snippet"""
    item = qt_get_item(item_id)
    if not item or item['type'] != 'text':
        return "Not found", 404

    return render_template(
        'snippet.html', item=item,
        size=qt_format_size(item['size_bytes']),
        time_remaining=qt_format_time_remaining(item['expires_at']),
    )


@bp.route('/raw/<item_id>')
def qt_raw_text(item_id):
    """Get raw text content"""
    item = qt_get_item(item_id)
    if not item or item['type'] != 'text':
        return "Not found", 404

    return item['content'], 200, {'Content-Type': 'text/plain; charset=utf-8'}


@bp.route('/delete/<item_id>', methods=['DELETE', 'POST'])
def qt_delete(item_id):
    """Delete an item"""
    if qt_delete_item(item_id):
        return jsonify({'success': True})
    return jsonify({'error': 'Not found'}), 404


@bp.route('/api/items')
def qt_list_items():
    """List all items"""
    metadata = qt_load_metadata()
    items = []

    for item_id, item in metadata['items'].items():
        if qt_is_expired(item):
            continue

        items.append({
            'id': item['id'],
            'type': item['type'],
            'name': item.get('original_name') or item.get('title', 'Untitled'),
            'size_bytes': item['size_bytes'],
            'created_at': item['created_at'],
            'expires_at': item['expires_at']
        })

    # Sort by creation time, newest first
    items.sort(key=lambda x: x['created_at'], reverse=True)

    return jsonify({'items': items})
