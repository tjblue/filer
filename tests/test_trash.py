"""Tests for Trash routes and service."""

from pathlib import Path
from app.trash.service import (
    trash_format_size,
    trash_move_to_trash,
    trash_restore,
    trash_delete_permanently,
    trash_empty_all,
    trash_list_items,
    trash_load_metadata,
)


class TestTrashServiceFunctions:
    """Tests for Trash service utility / business logic."""

    def test_format_size_none(self):
        assert trash_format_size(None) == "-"

    def test_format_size_bytes(self):
        assert trash_format_size(100) == "100 B"

    def test_format_size_kb(self):
        assert trash_format_size(2048) == "2.0 KB"

    def test_move_file_to_trash(self, app, root_dir):
        with app.app_context():
            result = trash_move_to_trash("file.txt", root_dir)
            assert result is not None
            assert result["name"] == "file.txt"
            assert not (root_dir / "file.txt").exists()

    def test_move_directory_to_trash(self, app, root_dir):
        with app.app_context():
            result = trash_move_to_trash("subdir", root_dir)
            assert result is not None
            assert result["is_directory"] is True
            assert not (root_dir / "subdir").exists()

    def test_restore_file(self, app, root_dir):
        with app.app_context():
            result = trash_move_to_trash("file.txt", root_dir)
            trash_id = result["trash_id"]

            restore_result = trash_restore(trash_id, root_dir)
            assert restore_result["success"] is True
            assert (root_dir / "file.txt").exists()

    def test_restore_fails_when_occupied(self, app, root_dir):
        with app.app_context():
            result = trash_move_to_trash("file.txt", root_dir)
            trash_id = result["trash_id"]

            # Re-create the file at the original path
            (root_dir / "file.txt").write_text("new content")

            restore_result = trash_restore(trash_id, root_dir)
            assert restore_result["success"] is False
            assert "already exists" in restore_result["error"]

    def test_delete_permanently(self, app, root_dir):
        with app.app_context():
            result = trash_move_to_trash("file.txt", root_dir)
            trash_id = result["trash_id"]

            del_result = trash_delete_permanently(trash_id)
            assert del_result["success"] is True

            # Should no longer be in metadata
            metadata = trash_load_metadata()
            assert trash_id not in metadata["items"]

    def test_empty_all(self, app, root_dir):
        with app.app_context():
            trash_move_to_trash("file.txt", root_dir)
            trash_move_to_trash("subdir", root_dir)

            result = trash_empty_all()
            assert result["success"] is True
            assert result["deleted_count"] == 2

            metadata = trash_load_metadata()
            assert len(metadata["items"]) == 0


class TestTrashRoutes:
    """Tests for Trash HTTP routes."""

    def test_list_items(self, client, root_dir, app):
        # Move a file to trash first
        with app.app_context():
            trash_move_to_trash("file.txt", root_dir)

        resp = client.get("/api/trash/items")
        assert resp.status_code == 200
        items = resp.get_json()["items"]
        assert len(items) >= 1
        assert items[0]["name"] == "file.txt"

    def test_restore_items(self, client, root_dir, app):
        with app.app_context():
            result = trash_move_to_trash("file.txt", root_dir)
            trash_id = result["trash_id"]

        resp = client.post("/api/trash/restore", json={"ids": [trash_id]})
        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["restored"]) == 1
        assert (root_dir / "file.txt").exists()

    def test_restore_empty_ids_400(self, client):
        resp = client.post("/api/trash/restore", json={"ids": []})
        assert resp.status_code == 400

    def test_delete_items(self, client, root_dir, app):
        with app.app_context():
            result = trash_move_to_trash("file.txt", root_dir)
            trash_id = result["trash_id"]

        resp = client.delete("/api/trash/delete", json={"ids": [trash_id]})
        assert resp.status_code == 200
        assert trash_id in resp.get_json()["deleted"]

    def test_empty_trash(self, client, root_dir, app):
        with app.app_context():
            trash_move_to_trash("file.txt", root_dir)

        resp = client.delete("/api/trash/empty")
        assert resp.status_code == 200
        assert resp.get_json()["success"] is True
