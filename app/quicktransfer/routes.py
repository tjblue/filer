"""
Quick Transfer HTTP routes - file and text snippet sharing.
"""

import os
from datetime import datetime, timedelta
from flask import Blueprint, render_template, request, jsonify, send_file, render_template_string
from werkzeug.utils import secure_filename

from app.config import (
    QT_UPLOAD_FOLDER,
    DEFAULT_EXPIRY_HOURS,
    MAX_EXPIRY_DAYS
)
from app.quicktransfer.service import (
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
    return render_template('napkins.html')#, network_ip=network_ip)


@bp.route('/upload', methods=['POST'])
def qt_upload_file():
    """Handle file upload"""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    # Get expiry time
    expiry_hours = request.form.get('expiry_hours', DEFAULT_EXPIRY_HOURS, type=int)
    expiry_hours = min(expiry_hours, MAX_EXPIRY_DAYS * 24)

    # Generate ID and filename
    item_id = qt_generate_id()
    original_name = secure_filename(file.filename) or 'unnamed'
    stored_name = f"{item_id}_{original_name}"
    file_path = os.path.join(QT_UPLOAD_FOLDER, stored_name)

    # Save file
    file.save(file_path)
    file_size = os.path.getsize(file_path)

    # Save metadata
    now = datetime.now()
    expires_at = now + timedelta(hours=expiry_hours)

    metadata = qt_load_metadata()
    metadata['items'][item_id] = {
        'id': item_id,
        'type': 'file',
        'original_name': original_name,
        'stored_name': stored_name,
        'size_bytes': file_size,
        'created_at': now.isoformat(),
        'expires_at': expires_at.isoformat()
    }
    qt_save_metadata(metadata)

    return jsonify({
        'success': True,
        'id': item_id,
        'download_url': f'/qt/download/{item_id}',
        'expires_at': expires_at.isoformat()
    })


@bp.route('/text', methods=['POST'])
def qt_upload_text():
    """Handle text snippet upload"""
    data = request.get_json()
    if not data or not data.get('content'):
        return jsonify({'error': 'No content provided'}), 400

    content = data['content']
    title = data.get('title', '').strip() or 'Untitled'
    expiry_hours = data.get('expiry_hours', DEFAULT_EXPIRY_HOURS)
    expiry_hours = min(int(expiry_hours), MAX_EXPIRY_DAYS * 24)

    item_id = qt_generate_id()
    now = datetime.now()
    expires_at = now + timedelta(hours=expiry_hours)

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
        'view_url': f'/qt/view/{item_id}',
        'raw_url': f'/qt/raw/{item_id}',
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
        file_path,
        as_attachment=True,
        download_name=item['original_name']
    )


@bp.route('/view/<item_id>')
def qt_view_text(item_id):
    """View a text snippet"""
    item = qt_get_item(item_id)
    if not item or item['type'] != 'text':
        return "Not found", 404

    # View template with Filer styling
    view_html = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>{item['title']} - Quick Transfer</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://unpkg.com/lucide@latest"></script>
    </head>
    <body class="bg-gray-900 min-h-screen p-4">
        <div class="max-w-4xl mx-auto">
            <div class="bg-gray-800 rounded-lg shadow-sm border border-gray-700 overflow-hidden">
                <div class="p-4 border-b border-gray-700 flex items-center justify-between flex-wrap gap-3" style="background-color: rgb(42 48 60);">
                    <div class="flex-1 min-w-0">
                        <h1 class="text-lg font-medium text-gray-100 truncate">{item['title']}</h1>
                        <div class="text-xs text-gray-400 mt-1 flex items-center gap-3 flex-wrap">
                            <span>{qt_format_size(item['size_bytes'])}</span>
                            <span class="flex items-center gap-1">
                                <i data-lucide="clock" class="w-3 h-3"></i>
                                expires in {qt_format_time_remaining(item['expires_at'])}
                            </span>
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="copyContent()" class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 flex items-center gap-1">
                            <i data-lucide="copy" class="w-4 h-4"></i> Copy
                        </button>
                        <a href="/qt/raw/{item_id}" class="px-3 py-1.5 bg-gray-700 text-gray-200 text-sm rounded hover:bg-gray-600 flex items-center gap-1">
                            <i data-lucide="file-text" class="w-4 h-4"></i> Raw
                        </a>
                        <a href="/qt/" class="px-3 py-1.5 bg-gray-700 text-gray-200 text-sm rounded hover:bg-gray-600 flex items-center gap-1">
                            <i data-lucide="arrow-left" class="w-4 h-4"></i> Back
                        </a>
                    </div>
                </div>
                <pre id="content" class="p-6 text-sm text-gray-200 bg-gray-900 overflow-x-auto whitespace-pre-wrap break-words font-mono leading-relaxed">{item['content']}</pre>
            </div>
        </div>
        <div id="toast" class="fixed bottom-4 right-4 px-4 py-2 rounded-lg shadow-lg text-white transform translate-y-20 transition-transform duration-300 bg-green-500"></div>
        <script>
            lucide.createIcons();

            function copyContent() {{
                const content = document.getElementById('content').textContent;
                navigator.clipboard.writeText(content).then(() => {{
                    const toast = document.getElementById('toast');
                    toast.textContent = 'Copied to clipboard!';
                    toast.style.transform = 'translateY(0)';
                    setTimeout(() => {{
                        toast.style.transform = 'translateY(100px)';
                    }}, 2000);
                }});
            }}
        </script>
    </body>
    </html>
    """
    return render_template_string(view_html)


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
