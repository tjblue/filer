"""Shared fixtures for Filer test suite."""

import os
import pytest
from pathlib import Path

from app import create_app


@pytest.fixture
def root_dir(tmp_path):
    """Create a temp directory populated with sample files."""
    # Text file
    (tmp_path / "file.txt").write_text("hello world", encoding="utf-8")

    # Binary file (small PNG header)
    (tmp_path / "image.png").write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        b"\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde"
    )

    # Subdirectory with nested file
    subdir = tmp_path / "subdir"
    subdir.mkdir()
    (subdir / "nested.txt").write_text("nested content", encoding="utf-8")

    # Empty directory
    (tmp_path / "empty_dir").mkdir()

    # Hidden file (for search exclusion tests)
    (tmp_path / ".hidden").write_text("secret", encoding="utf-8")

    return tmp_path


@pytest.fixture
def app(root_dir, tmp_path_factory):
    """Create a Flask app with TESTING=True and isolated data dirs."""
    # Create isolated data directories so tests don't touch real data
    data_dir = tmp_path_factory.mktemp("data")
    trash_folder = str(data_dir / "trash")
    trash_meta = str(data_dir / "trash_metadata.json")
    qt_folder = str(data_dir / "uploads")
    qt_meta = str(data_dir / "metadata.json")
    settings_file = str(data_dir / "settings.json")

    os.makedirs(trash_folder, exist_ok=True)
    os.makedirs(qt_folder, exist_ok=True)

    # Monkeypatch config constants before creating app
    import app.config as cfg
    orig = (cfg.TRASH_FOLDER, cfg.TRASH_METADATA_FILE,
            cfg.QT_UPLOAD_FOLDER, cfg.QT_METADATA_FILE,
            cfg.SETTINGS_FILE)

    cfg.TRASH_FOLDER = trash_folder
    cfg.TRASH_METADATA_FILE = trash_meta
    cfg.QT_UPLOAD_FOLDER = qt_folder
    cfg.QT_METADATA_FILE = qt_meta
    cfg.SETTINGS_FILE = settings_file

    # Also patch service modules that already imported these
    import app.trash.service as ts
    ts.TRASH_FOLDER = trash_folder
    ts.TRASH_METADATA_FILE = trash_meta

    import app.quicktransfer.service as qs
    qs.QT_UPLOAD_FOLDER = qt_folder
    qs.QT_METADATA_FILE = qt_meta

    import app.quicktransfer.routes as qr
    qr.QT_UPLOAD_FOLDER = qt_folder

    import app.settings.service as ss
    ss.SETTINGS_FILE = settings_file

    application = create_app(root_dir)
    application.config['TESTING'] = True
    application.config['DATA_DIR'] = data_dir

    yield application

    # Restore originals
    cfg.TRASH_FOLDER, cfg.TRASH_METADATA_FILE, \
        cfg.QT_UPLOAD_FOLDER, cfg.QT_METADATA_FILE, \
        cfg.SETTINGS_FILE = orig
    ts.TRASH_FOLDER, ts.TRASH_METADATA_FILE = orig[0], orig[1]
    qs.QT_UPLOAD_FOLDER, qs.QT_METADATA_FILE = orig[2], orig[3]
    qr.QT_UPLOAD_FOLDER = orig[2]
    ss.SETTINGS_FILE = orig[4]


@pytest.fixture
def client(app):
    """Flask test client."""
    return app.test_client()
