"""
Trash HTTP routes - trash management operations.
"""

from flask import Blueprint, render_template, request, jsonify, current_app

from app.trash.service import (
    trash_list_items,
    trash_restore,
    trash_delete_permanently,
    trash_empty_all
)

# Create Blueprint — serves both the page at /trash/ and API at /api/trash/
bp = Blueprint('trash', __name__)


@bp.route('/trash/')
def trash_page():
    """Serve the Trash UI."""
    return render_template('trash.html')


@bp.route('/api/trash/items')
def list_items():
    """List all items in trash."""
    items = trash_list_items()
    return jsonify({'items': items})


@bp.route('/api/trash/restore', methods=['POST'])
def restore_items():
    """Restore items from trash."""
    ROOT_DIR = current_app.config['ROOT_DIR']
    data = request.get_json()
    ids = data.get('ids', [])

    if not ids:
        return jsonify({'error': 'No IDs provided'}), 400

    restored = []
    errors = []

    for trash_id in ids:
        result = trash_restore(trash_id, ROOT_DIR)
        if result['success']:
            restored.append({'id': trash_id, 'path': result['restored_path']})
        else:
            errors.append({'id': trash_id, 'error': result['error']})

    return jsonify({'restored': restored, 'errors': errors})


@bp.route('/api/trash/delete', methods=['DELETE'])
def delete_items():
    """Permanently delete items from trash."""
    data = request.get_json()
    ids = data.get('ids', [])

    if not ids:
        return jsonify({'error': 'No IDs provided'}), 400

    deleted = []
    errors = []

    for trash_id in ids:
        result = trash_delete_permanently(trash_id)
        if result['success']:
            deleted.append(trash_id)
        else:
            errors.append({'id': trash_id, 'error': result['error']})

    return jsonify({'deleted': deleted, 'errors': errors})


@bp.route('/api/trash/empty', methods=['DELETE'])
def empty_trash():
    """Empty entire trash."""
    result = trash_empty_all()
    return jsonify(result)
