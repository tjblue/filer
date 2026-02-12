"""Tests for filer routes — file browser API."""

import io
import zipfile
import pytest


class TestListFiles:
    """GET /api/files"""

    def test_lists_root_contents(self, client):
        resp = client.get("/api/files")
        assert resp.status_code == 200
        data = resp.get_json()
        names = [i["name"] for i in data["items"]]
        assert "file.txt" in names
        assert "subdir" in names

    def test_lists_subdirectory(self, client):
        resp = client.get("/api/files?path=subdir")
        assert resp.status_code == 200
        names = [i["name"] for i in resp.get_json()["items"]]
        assert "nested.txt" in names

    def test_nonexistent_directory_404(self, client):
        resp = client.get("/api/files?path=nope")
        assert resp.status_code == 404

    def test_file_path_returns_400(self, client):
        resp = client.get("/api/files?path=file.txt")
        assert resp.status_code == 400

    def test_directories_sorted_before_files(self, client):
        resp = client.get("/api/files")
        items = resp.get_json()["items"]
        dir_indices = [i for i, x in enumerate(items) if x["isDirectory"]]
        file_indices = [i for i, x in enumerate(items) if not x["isDirectory"]]
        if dir_indices and file_indices:
            assert max(dir_indices) < min(file_indices)


class TestGetFile:
    """GET /api/file"""

    def test_returns_text_content(self, client):
        resp = client.get("/api/file?path=file.txt")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["content"] == "hello world"
        assert data["isBinary"] is False

    def test_returns_binary_flag(self, client):
        resp = client.get("/api/file?path=image.png")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["isBinary"] is True

    def test_nonexistent_file_404(self, client):
        resp = client.get("/api/file?path=nope.txt")
        assert resp.status_code == 404


class TestCreateFile:
    """POST /api/file"""

    def test_create_empty_file(self, client, root_dir):
        resp = client.post("/api/file", json={"parent": "", "name": "new.txt", "isFolder": False})
        assert resp.status_code == 200
        assert (root_dir / "new.txt").exists()

    def test_create_folder(self, client, root_dir):
        resp = client.post("/api/file", json={"parent": "", "name": "newfolder", "isFolder": True})
        assert resp.status_code == 200
        assert (root_dir / "newfolder").is_dir()

    def test_empty_name_400(self, client):
        resp = client.post("/api/file", json={"parent": "", "name": "", "isFolder": False})
        assert resp.status_code == 400

    def test_slash_in_name_400(self, client):
        resp = client.post("/api/file", json={"parent": "", "name": "a/b", "isFolder": False})
        assert resp.status_code == 400

    def test_dotdot_in_name_400(self, client):
        resp = client.post("/api/file", json={"parent": "", "name": "..", "isFolder": False})
        assert resp.status_code == 400

    def test_duplicate_name_409(self, client):
        resp = client.post("/api/file", json={"parent": "", "name": "file.txt", "isFolder": False})
        assert resp.status_code == 409


class TestUpdateFile:
    """PUT /api/file"""

    def test_update_content(self, client, root_dir):
        resp = client.put("/api/file", json={"path": "file.txt", "content": "updated"})
        assert resp.status_code == 200
        assert (root_dir / "file.txt").read_text() == "updated"

    def test_nonexistent_file_404(self, client):
        resp = client.put("/api/file", json={"path": "nope.txt", "content": "x"})
        assert resp.status_code == 404


class TestDeleteFile:
    """DELETE /api/file"""

    def test_delete_moves_to_trash(self, client, root_dir):
        resp = client.delete("/api/file", json={"paths": ["file.txt"]})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "file.txt" in data["deleted"]
        assert not (root_dir / "file.txt").exists()

    def test_nonexistent_path_error(self, client):
        resp = client.delete("/api/file", json={"paths": ["nope.txt"]})
        data = resp.get_json()
        assert len(data["errors"]) > 0

    def test_empty_paths_400(self, client):
        resp = client.delete("/api/file", json={"paths": []})
        assert resp.status_code == 400


class TestRename:
    """POST /api/rename"""

    def test_rename_file(self, client, root_dir):
        resp = client.post("/api/rename", json={"path": "file.txt", "newName": "renamed.txt"})
        assert resp.status_code == 200
        assert not (root_dir / "file.txt").exists()
        assert (root_dir / "renamed.txt").exists()

    def test_empty_name_400(self, client):
        resp = client.post("/api/rename", json={"path": "file.txt", "newName": ""})
        assert resp.status_code == 400

    def test_slash_in_name_400(self, client):
        resp = client.post("/api/rename", json={"path": "file.txt", "newName": "a/b"})
        assert resp.status_code == 400

    def test_destination_exists_409(self, client, root_dir):
        (root_dir / "other.txt").write_text("x")
        resp = client.post("/api/rename", json={"path": "file.txt", "newName": "other.txt"})
        assert resp.status_code == 409


class TestMove:
    """POST /api/move"""

    def test_move_file(self, client, root_dir):
        resp = client.post("/api/move", json={
            "items": [{"source": "file.txt", "destination": "subdir/file.txt"}]
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["moved"]) == 1
        assert (root_dir / "subdir" / "file.txt").exists()

    def test_nonexistent_source_error(self, client):
        resp = client.post("/api/move", json={
            "items": [{"source": "nope.txt", "destination": "subdir/nope.txt"}]
        })
        data = resp.get_json()
        assert len(data["errors"]) > 0


class TestUpload:
    """POST /api/upload"""

    def test_upload_file(self, client, root_dir):
        data = {"files": (io.BytesIO(b"uploaded content"), "upload.txt")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 200
        assert (root_dir / "upload.txt").exists()
        assert (root_dir / "upload.txt").read_bytes() == b"uploaded content"

    def test_upload_preserves_filename(self, client, root_dir):
        data = {"files": (io.BytesIO(b"x"), "myfile.dat")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        uploaded = resp.get_json()["uploaded"]
        assert any("myfile.dat" in u for u in uploaded)


class TestDownload:
    """GET /api/download"""

    def test_download_file(self, client):
        resp = client.get("/api/download?path=file.txt")
        assert resp.status_code == 200
        assert resp.data == b"hello world"


class TestZip:
    """GET /api/zip"""

    def test_zip_download(self, client):
        resp = client.get("/api/zip?paths=file.txt&paths=subdir/nested.txt")
        assert resp.status_code == 200
        assert resp.content_type == "application/zip"
        with zipfile.ZipFile(io.BytesIO(resp.data)) as zf:
            names = zf.namelist()
            assert "file.txt" in names
            assert "nested.txt" in names


class TestFolders:
    """GET /api/folders"""

    def test_returns_folder_tree(self, client):
        resp = client.get("/api/folders")
        assert resp.status_code == 200
        data = resp.get_json()
        names = [f["name"] for f in data["folders"]]
        assert "subdir" in names
        assert "empty_dir" in names

    def test_excludes_hidden_dirs(self, client, root_dir):
        (root_dir / ".secret_dir").mkdir()
        resp = client.get("/api/folders")
        names = [f["name"] for f in resp.get_json()["folders"]]
        assert ".secret_dir" not in names
