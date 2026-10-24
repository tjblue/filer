"""
Flask app factory for Filer application.
"""

import os
from pathlib import Path
from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException
from app.filesystem import filesystem_error, InsufficientStorage
from app.config import MAX_FILE_SIZE_MB


def create_app(root_dir: Path, port: int = 5000):
    """
    Create and configure the Flask application.

    Args:
        root_dir: Root directory for file management
        port: Port number for the server

    Returns:
        Configured Flask application
    """
    # Get the project root directory (parent of the app package)
    project_root = Path(__file__).parent.parent

    # Create Flask app with correct template and static folders
    # Use /_static to avoid conflicts with files being served
    app = Flask(
        __name__,
        template_folder=str(project_root / "templates"),
        static_folder=str(project_root / "static"),
        static_url_path="/_static",
    )

    # Store configuration
    app.config["ROOT_DIR"] = Path(root_dir).resolve()
    app.config["PORT"] = port
    app.config["DATA_DIR"] = project_root / "data"
    app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE_MB * 1024 * 1024 + 16 * 1024 * 1024
    app.aborter.mapping[507] = InsufficientStorage

    @app.errorhandler(HTTPException)
    def http_error(error):
        if request.path.startswith('/api/') or request.path == '/settings/api' or request.path.startswith('/napkins/'):
            return jsonify(error=error.description), error.code
        return error

    @app.errorhandler(OSError)
    def file_error(error):
        message, status = filesystem_error(error)
        if status == 500:
            app.logger.exception('Filesystem operation failed')
        return jsonify(error=message), status

    # Register blueprints
    from app.filer.routes import bp as filer_bp
    from app.quicktransfer.routes import bp as qt_bp
    from app.trash.routes import bp as trash_bp
    from app.settings.routes import bp as settings_bp
    from app.filer.operations import bp as operations_bp

    # Register specific blueprints before filer's catch-all route
    app.register_blueprint(qt_bp)
    app.register_blueprint(trash_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(operations_bp)
    app.register_blueprint(filer_bp)

    return app
