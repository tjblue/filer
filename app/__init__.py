"""
Flask app factory for Filer application.
"""

import os
from pathlib import Path
from flask import Flask


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
    app = Flask(__name__,
                template_folder=str(project_root / 'templates'),
                static_folder=str(project_root / 'static'),
                static_url_path='/_static')

    # Store configuration
    app.config['ROOT_DIR'] = root_dir
    app.config['PORT'] = port

    # Register blueprints
    from app.filer.routes import bp as filer_bp
    from app.quicktransfer.routes import bp as qt_bp
    from app.trash.routes import bp as trash_bp
    from app.settings.routes import bp as settings_bp

    # Register specific blueprints before filer's catch-all route
    app.register_blueprint(qt_bp)
    app.register_blueprint(trash_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(filer_bp)

    return app
