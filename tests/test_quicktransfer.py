"""Tests for Quick Transfer routes and service."""

import io
import pytest
from datetime import datetime, timedelta

from app.quicktransfer.service import (
    qt_generate_id,
    qt_format_size,
    qt_format_time_remaining,
    qt_is_expired,
)


@pytest.mark.parametrize('limit,label', [(5120, '5 GiB'), (256, '256 MiB')])
def test_napkins_loads_shared_theme_and_displays_configured_limit(client, monkeypatch, limit, label):
    monkeypatch.setattr('app.quicktransfer.routes.MAX_FILE_SIZE_MB', limit)
    response = client.get('/napkins/')
    assert response.status_code == 200
    page = response.get_data(as_text=True)
    assert 'href="/_static/style.css"' in page
    assert f'Maximum file size: {label}' in page
    assert '100MB' not in page


class TestQTServiceFunctions:
    """Tests for Quick Transfer utility functions."""

    def test_generate_id_length(self):
        result = qt_generate_id()
        assert len(result) == 8
        assert all(c in "0123456789abcdef" for c in result)

    def test_format_size_bytes(self):
        assert qt_format_size(500) == "500 B"

    def test_format_size_kb(self):
        assert qt_format_size(2048) == "2.0 KB"

    def test_format_size_mb(self):
        assert qt_format_size(5 * 1024 * 1024) == "5.0 MB"

    def test_format_size_gb(self):
        assert qt_format_size(2 * 1024 * 1024 * 1024) == "2.0 GB"

    def test_format_time_remaining_hours(self):
        future = (datetime.now() + timedelta(hours=3, minutes=15)).isoformat()
        result = qt_format_time_remaining(future)
        assert "3h" in result

    def test_format_time_remaining_days(self):
        future = (datetime.now() + timedelta(days=2, hours=5)).isoformat()
        result = qt_format_time_remaining(future)
        assert "2d" in result

    def test_format_time_remaining_expired(self):
        past = (datetime.now() - timedelta(hours=1)).isoformat()
        assert qt_format_time_remaining(past) == "Expired"

    def test_is_expired_true(self):
        item = {"expires_at": (datetime.now() - timedelta(hours=1)).isoformat()}
        assert qt_is_expired(item) is True

    def test_is_expired_false(self):
        item = {"expires_at": (datetime.now() + timedelta(hours=1)).isoformat()}
        assert qt_is_expired(item) is False


class TestQTUploadRoute:
    """POST /napkins/upload"""

    def test_upload_file(self, client):
        data = {"file": (io.BytesIO(b"test data"), "test.txt")}
        resp = client.post("/napkins/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["success"] is True
        assert "id" in body
        assert "download_url" in body

    def test_no_file_400(self, client):
        resp = client.post("/napkins/upload", data={}, content_type="multipart/form-data")
        assert resp.status_code == 400


class TestQTTextRoute:
    """POST /napkins/text"""

    def test_create_text_snippet(self, client):
        resp = client.post("/napkins/text", json={"content": "some text", "title": "My Note"})
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["success"] is True
        assert "id" in body
        assert "view_url" in body
        assert "raw_url" in body

    def test_no_content_400(self, client):
        resp = client.post("/napkins/text", json={"content": ""})
        assert resp.status_code == 400


class TestQTDownloadRoute:
    """GET /napkins/download/<id>"""

    def test_download_uploaded_file(self, client):
        # Upload first
        data = {"file": (io.BytesIO(b"download me"), "dl.txt")}
        upload_resp = client.post("/napkins/upload", data=data, content_type="multipart/form-data")
        item_id = upload_resp.get_json()["id"]

        # Download
        resp = client.get(f"/napkins/download/{item_id}")
        assert resp.status_code == 200
        assert resp.data == b"download me"

    def test_nonexistent_id_404(self, client):
        resp = client.get("/napkins/download/nonexist")
        assert resp.status_code == 404


class TestQTViewRoute:
    """GET /napkins/view/<id> and /napkins/raw/<id>"""

    def _create_snippet(self, client, content="hello"):
        resp = client.post("/napkins/text", json={"content": content, "title": "Test"})
        return resp.get_json()["id"]

    def test_view_text(self, client):
        item_id = self._create_snippet(client, "view me")
        resp = client.get(f"/napkins/view/{item_id}")
        assert resp.status_code == 200

    def test_raw_text(self, client):
        item_id = self._create_snippet(client, "raw content")
        resp = client.get(f"/napkins/raw/{item_id}")
        assert resp.status_code == 200
        assert b"raw content" in resp.data


class TestQTDeleteRoute:
    """DELETE /napkins/delete/<id>"""

    def test_delete_item(self, client):
        data = {"file": (io.BytesIO(b"x"), "del.txt")}
        upload_resp = client.post("/napkins/upload", data=data, content_type="multipart/form-data")
        item_id = upload_resp.get_json()["id"]

        resp = client.delete(f"/napkins/delete/{item_id}")
        assert resp.status_code == 200
        assert resp.get_json()["success"] is True

        # Should be gone
        resp = client.get(f"/napkins/download/{item_id}")
        assert resp.status_code == 404


class TestQTListItems:
    """GET /napkins/api/items"""

    def test_list_items(self, client):
        # Upload a file
        data = {"file": (io.BytesIO(b"list me"), "list.txt")}
        client.post("/napkins/upload", data=data, content_type="multipart/form-data")

        resp = client.get("/napkins/api/items")
        assert resp.status_code == 200
        items = resp.get_json()["items"]
        assert len(items) >= 1

    def test_expired_items_excluded(self, client, app):
        """Expired items should not appear in the listing."""
        import app.quicktransfer.service as qs

        # Create item, then manually expire it
        data = {"file": (io.BytesIO(b"expire me"), "expire.txt")}
        upload_resp = client.post("/napkins/upload", data=data, content_type="multipart/form-data")
        item_id = upload_resp.get_json()["id"]

        # Manually set expiry to the past
        metadata = qs.qt_load_metadata()
        metadata["items"][item_id]["expires_at"] = (
            datetime.now() - timedelta(hours=1)
        ).isoformat()
        qs.qt_save_metadata(metadata)

        resp = client.get("/napkins/api/items")
        ids = [i["id"] for i in resp.get_json()["items"]]
        assert item_id not in ids
