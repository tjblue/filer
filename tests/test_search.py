"""Tests for search functionality (Python fallback)."""

from app.filer.search import search_with_python


class TestSearchWithPython:
    """Tests for search_with_python() fallback."""

    def test_finds_by_name(self, app, root_dir):
        with app.test_request_context():
            results = search_with_python("file", root_dir, 100)
            names = [r["name"] for r in results]
            assert "file.txt" in names

    def test_finds_by_content(self, app, root_dir):
        with app.test_request_context():
            results = search_with_python("hello world", root_dir, 100)
            assert len(results) >= 1
            assert any(r["contentMatches"] for r in results)

    def test_skips_hidden_files(self, app, root_dir):
        with app.test_request_context():
            results = search_with_python("secret", root_dir, 100)
            names = [r["name"] for r in results]
            assert ".hidden" not in names

    def test_skips_binary_content(self, app, root_dir):
        """Binary files are not searched by content (only matched by name)."""
        with app.test_request_context():
            # "IHDR" is inside the PNG binary data but not in the filename,
            # so it should NOT be found since binary content is skipped.
            results = search_with_python("IHDR", root_dir, 100)
            names = [r["name"] for r in results]
            assert "image.png" not in names

    def test_respects_max_results(self, app, root_dir):
        with app.test_request_context():
            results = search_with_python("e", root_dir, 1)
            assert len(results) <= 1

    def test_no_matches(self, app, root_dir):
        with app.test_request_context():
            results = search_with_python("zzzznotfound", root_dir, 100)
            assert results == []


class TestSearchAPI:
    """Tests for GET /api/search."""

    def test_returns_results(self, client):
        resp = client.get("/api/search?q=file")
        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["results"]) >= 1

    def test_empty_query_returns_empty(self, client):
        resp = client.get("/api/search?q=zzzznotfound")
        data = resp.get_json()
        assert data["results"] == []
