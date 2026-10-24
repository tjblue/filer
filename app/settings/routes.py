"""
Settings HTTP routes - application settings management.
"""

from flask import Blueprint, render_template, request, jsonify, abort
from app.filesystem import json_object
from app.settings.service import settings_load, settings_save, DEFAULT_SETTINGS, settings_lock

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
@settings_lock
def save_settings():
    """Save settings and return updated values."""
    data = json_object(request)
    allowed = {"theme": {"dark", "light"}, "fontSize": {"sm", "medium", "lg"}, "previewScale": {"off", "sm", "md", "lg"}}
    for key, choices in allowed.items():
        if key in data and (not isinstance(data[key], str) or data[key] not in choices):
            abort(400, f"Invalid value for {key}")
    current = settings_load()

    # Only allow known keys
    for key in DEFAULT_SETTINGS:
        if key in data:
            current[key] = data[key]

    settings_save(current)
    return jsonify(current)
