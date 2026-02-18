"""Tests for app.utils - safe_path() and get_file_info()."""

import pytest
from app.utils import safe_path, get_file_info


class TestSafePath:
    """Tests for the safe_path() path-validation helper."""

    def test_empty_string_returns_root(self, app, root_dir):
        with app.test_request_context():
            assert safe_path("") == root_dir

    def test_valid_relative_path(self, app, root_dir):
        with app.test_request_context():
            result = safe_path("file.txt")
            assert result == (root_dir / "file.txt").resolve()

    def test_dotdot_returns_403(self, app):
        with app.test_request_context():
            with pytest.raises(Exception) as exc:
                safe_path("..")
            assert exc.value.code == 403

    def test_traversal_etc_passwd_returns_403(self, app):
        with app.test_request_context():
            with pytest.raises(Exception) as exc:
                safe_path("../../etc/passwd")
            assert exc.value.code == 403

    def test_traversal_nested_returns_403(self, app):
        with app.test_request_context():
            with pytest.raises(Exception) as exc:
                safe_path("folder/../../outside")
            assert exc.value.code == 403

    def test_mixed_separators_returns_403(self, app):
        with app.test_request_context():
            with pytest.raises(Exception) as exc:
                safe_path("folder\\..\\file")
            assert exc.value.code == 403

    def test_leading_trailing_slashes(self, app, root_dir):
        with app.test_request_context():
            result = safe_path("/file.txt/")
            assert result == (root_dir / "file.txt").resolve()

    def test_subdirectory_path(self, app, root_dir):
        with app.test_request_context():
            result = safe_path("subdir/nested.txt")
            assert result == (root_dir / "subdir" / "nested.txt").resolve()


class TestGetFileInfo:
    """Tests for the get_file_info() helper."""

    def test_file_info(self, app, root_dir):
        path = root_dir / "file.txt"
        info = get_file_info(path, root_dir)
        assert info["name"] == "file.txt"
        assert info["isDirectory"] is False
        assert isinstance(info["size"], int)
        assert info["size"] > 0
        assert "modified" in info

    def test_directory_info(self, app, root_dir):
        path = root_dir / "subdir"
        info = get_file_info(path, root_dir)
        assert info["name"] == "subdir"
        assert info["isDirectory"] is True
        assert info["size"] is None
