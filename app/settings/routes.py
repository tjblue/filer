"""
Settings HTTP routes - application settings management.
"""

from flask import Blueprint, render_template, request, jsonify
from app.settings.service import settings_load, settings_save, DEFAULT_SETTINGS

bp = Blueprint('settings', __name__, url_prefix='/settings')


@bp.route('/')
def settings_page():
    """Serve the Settings UI."""
    return render_template('settings.html')


@bp.route('/api')
def get_settings():
    """Return current settings as JSON."""
    return jsonify(settings_load())


@bp.route('/api', methods=['POST'])
def save_settings():
    """Save settings and return updated values."""
    data = request.get_json()
    current = settings_load()

    # Only allow known keys
    for key in DEFAULT_SETTINGS:
        if key in data:
            current[key] = data[key]

    settings_save(current)
    return jsonify(current)
