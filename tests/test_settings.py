"""Tests for Settings routes and service."""

import json
from app.settings.service import settings_load, settings_save, DEFAULT_SETTINGS, SETTINGS_FILE


class TestSettingsService:
    """Tests for settings_load() and settings_save()."""

    def test_load_defaults_when_missing(self, app):
        with app.app_context():
            result = settings_load()
            assert result == DEFAULT_SETTINGS

    def test_load_defaults_when_corrupted(self, app):
        with app.app_context():
            import app.settings.service as ss
            with open(ss.SETTINGS_FILE, "w") as f:
                f.write("{invalid json!!!")
            result = settings_load()
            assert result == DEFAULT_SETTINGS

    def test_save_persists(self, app):
        with app.app_context():
            import app.settings.service as ss
            data = {"theme": "light", "fontSize": "large", "previewScale": "on"}
            settings_save(data)

            with open(ss.SETTINGS_FILE, "r") as f:
                saved = json.load(f)
            assert saved["theme"] == "light"


class TestSettingsRoutes:
    """Tests for Settings HTTP routes."""

    def test_get_default_settings(self, client):
        resp = client.get("/settings/api")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["theme"] == "dark"
        assert data["fontSize"] == "medium"

    def test_save_settings(self, client):
        resp = client.post("/settings/api", json={"theme": "light"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["theme"] == "light"
        # Other defaults preserved
        assert data["fontSize"] == "medium"

    def test_ignores_unknown_keys(self, client):
        resp = client.post("/settings/api", json={"theme": "light", "unknown_key": "value"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "unknown_key" not in data
