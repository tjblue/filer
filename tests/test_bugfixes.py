"""Behavioral coverage for the second bug review."""

import io
import json
import shutil
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import pytest
from PIL import Image

import app.trash.service as trash


def test_trash_restore_requires_original_root(app, root_dir, tmp_path):
    item = trash.trash_move_to_trash("file.txt", root_dir)
    other = tmp_path / "other"
    other.mkdir()
    assert not trash.trash_restore(item["trash_id"], other)["success"]
    assert not (other / "file.txt").exists()
    assert item["trash_id"] in trash.trash_load_metadata()["items"]
    assert trash.trash_restore(item["trash_id"], root_dir)["success"]
    assert (root_dir / "file.txt").read_text() == "hello world"


def test_legacy_trash_item_does_not_guess_root(app, root_dir):
    item = trash.trash_move_to_trash("file.txt", root_dir)
    metadata = trash.trash_load_metadata()
    del metadata["items"][item["trash_id"]]["original_root"]
    trash.trash_save_metadata(metadata)
    result = trash.trash_restore(item["trash_id"], root_dir)
    assert not result["success"]
    assert "unknown" in result["error"]
    assert item["trash_id"] in trash.trash_load_metadata()["items"]


def test_empty_trash_keeps_locked_item_and_reports_partial_failure(client, root_dir, monkeypatch):
    locked = trash.trash_move_to_trash("file.txt", root_dir)
    removed = trash.trash_move_to_trash("subdir", root_dir)
    real_rmtree = shutil.rmtree
    def delete(path, *args, **kwargs):
        if str(path).endswith(locked["trash_id"]):
            raise PermissionError("file locked")
        return real_rmtree(path, *args, **kwargs)
    monkeypatch.setattr(trash.shutil, "rmtree", delete)
    response = client.delete("/api/trash/empty")
    assert response.status_code == 200
    assert response.json["success"] is False
    assert response.json["deleted_count"] == 1
    assert response.json["errors"][0]["id"] == locked["trash_id"]
    assert set(trash.trash_load_metadata()["items"]) == {locked["trash_id"]}
    assert removed["trash_id"] not in trash.trash_load_metadata()["items"]


def test_expiry_cleanup_retries_locked_files(app, root_dir, monkeypatch):
    from app.trash.cleanup import trash_cleanup_once
    item = trash.trash_move_to_trash("file.txt", root_dir)
    metadata = trash.trash_load_metadata()
    metadata["items"][item["trash_id"]]["deleted_at"] = (datetime.now() - timedelta(days=30)).isoformat()
    trash.trash_save_metadata(metadata)
    real_rmtree = shutil.rmtree
    def fail(*args, **kwargs):
        raise PermissionError("file locked")
    monkeypatch.setattr(trash.shutil, "rmtree", fail)
    assert trash_cleanup_once() == 0
    assert item["trash_id"] in trash.trash_load_metadata()["items"]
    monkeypatch.setattr(trash.shutil, "rmtree", real_rmtree)
    assert trash_cleanup_once() == 1
    assert trash.trash_load_metadata()["items"] == {}


@pytest.mark.parametrize("mode,extension", [("RGBA", "png"), ("LA", "png"), ("P", "gif"), ("RGB", "jpg")])
def test_thumbnails_support_image_modes(client, root_dir, mode, extension):
    name = f"preview.{extension}"
    Image.new(mode, (16, 16)).save(root_dir / name)
    with client.get("/api/thumb", query_string={"path": name, "size": 8}) as response:
        assert response.status_code == 200
        with Image.open(io.BytesIO(response.data)) as thumb:
            assert thumb.mode == "RGB"
            assert thumb.size == (8, 8)


def test_thumbnail_background_cache_is_reused(client, root_dir, app, monkeypatch):
    import app.filer.routes as routes
    from app.cache.thumb_cache import get_cached_thumb
    source = root_dir / "transparent.png"
    Image.new("RGBA", (8, 8)).save(source)
    saved = threading.Event()
    original_save = routes.save_thumb_cache
    def save(*args):
        try:
            original_save(*args)
        finally:
            saved.set()
    monkeypatch.setattr(routes, "save_thumb_cache", save)
    with client.get("/api/thumb", query_string={"path": source.name}) as response:
        assert response.status_code == 200
        expected = response.data
    assert saved.wait(timeout=5)
    with app.app_context():
        assert get_cached_thumb(source, 150) == expected


def test_exif_timer_writes_outside_flask_context_and_batches(app, root_dir, monkeypatch):
    import app.cache.exif_cache as cache
    timers = []
    class Timer:
        def __init__(self, delay, function, args):
            self.function, self.args = function, args
            timers.append(self)
        def start(self):
            pass
        def cancel(self):
            pass
    monkeypatch.setattr(cache.threading, "Timer", Timer)
    date = datetime(2026, 1, 2, 3, 4, 5)
    with app.app_context():
        cache.set_cached_exif_date(root_dir / "file.txt", date)
        cache.set_cached_exif_date(root_dir / "subdir/nested.txt", date)
        filename = cache._get_cache_path()
    assert len(timers) == 1
    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(timers[0].function, *timers[0].args).result()
    assert len(json.loads(filename.read_text())) == 2
    with cache._cache_lock:
        del cache._caches[filename]
    with app.app_context():
        assert cache.get_cached_exif_date(root_dir / "file.txt") == date


def test_range_response_has_partial_content_length(client):
    with client.get("/api/download?path=file.txt", headers={"Range": "bytes=0-3"}) as response:
        assert response.status_code == 206
        assert response.data == b"hell"
        assert response.headers["Content-Length"] == "4"
        assert response.headers["Content-Range"] == "bytes 0-3/11"


def test_zip_preserves_duplicate_basenames_and_deduplicates_selections(client, root_dir):
    for name in ["a", "b"]:
        folder = root_dir / name
        folder.mkdir()
        (folder / "report.txt").write_text(name)
    response = client.get("/api/zip", query_string=[
        ("paths", "a"), ("paths", "a/report.txt"), ("paths", "b/report.txt"),
    ])
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        assert archive.read("a/report.txt") == b"a"
        assert archive.read("b/report.txt") == b"b"


@pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is not installed")
@pytest.mark.parametrize("query", ["[", "a.b", "-needle", "hello"])
def test_ripgrep_uses_literal_search_like_python(app, root_dir, query):
    from app.filer.search import search_with_python, search_with_ripgrep
    (root_dir / "note.txt").write_text("hello [literal] -needle axb")
    with app.app_context():
        ripgrep = search_with_ripgrep(query, root_dir, 100)
        python = search_with_python(query, root_dir, 100)
    assert ripgrep is not None
    assert {item["path"] for item in ripgrep} == {item["path"] for item in python}
