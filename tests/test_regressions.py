"""Regression coverage for template injection, upload integrity, and transactions."""

import io
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest


@pytest.fixture
def chunks(client, monkeypatch):
    import app.filer.routes as routes
    monkeypatch.setattr(routes, "CHUNK_SIZE", 4)
    yield client
    with routes._uploads_lock:
        for info in routes._active_uploads.values():
            info["path"].unlink(missing_ok=True)
        routes._active_uploads.clear()


def start(client, name="uploaded.txt", size=8):
    response = client.post("/api/upload/init", json={"fileName": name, "fileSize": size})
    assert response.status_code == 200
    return response.json["uploadId"]


def send_chunk(client, uid, index, data):
    return client.post("/api/upload/chunk", data={
        "uploadId": uid, "chunkIndex": str(index),
        "chunk": (io.BytesIO(data), "chunk"),
    })


def test_cancel_preserves_existing_file(chunks, root_dir):
    uid = start(chunks, "file.txt")
    assert (root_dir / "file.txt").read_text() == "hello world"
    assert send_chunk(chunks, uid, 0, b"abcd").status_code == 200
    assert chunks.post("/api/upload/cancel", json={"uploadId": uid}).status_code == 200
    assert (root_dir / "file.txt").read_text() == "hello world"
    assert not list(root_dir.glob(".filer-*.part"))


def test_incomplete_upload_can_be_retried(chunks, root_dir):
    uid = start(chunks, "file.txt")
    assert send_chunk(chunks, uid, 1, b"efgh").status_code == 200
    assert send_chunk(chunks, uid, 1, b"efgh").status_code == 200
    assert chunks.post("/api/upload/complete", json={"uploadId": uid}).status_code == 409
    assert send_chunk(chunks, uid, 0, b"abcd").status_code == 200
    # Repeated chunks must not falsely increase the completion count.
    assert send_chunk(chunks, uid, 0, b"abcd").status_code == 200
    result = chunks.post("/api/upload/complete", json={"uploadId": uid})
    assert result.status_code == 200
    assert result.json["path"] == "file (1).txt"
    assert (root_dir / "file (1).txt").read_bytes() == b"abcdefgh"
    assert (root_dir / "file.txt").read_text() == "hello world"


@pytest.mark.parametrize("index,payload", [(-1, b"abcd"), (2, b"abcd"), (0, b"abc"), (0, b"abcde")])
def test_invalid_chunks_rejected(chunks, index, payload):
    uid = start(chunks)
    assert send_chunk(chunks, uid, index, payload).status_code == 400
    assert chunks.post("/api/upload/complete", json={"uploadId": uid}).status_code == 409


@pytest.mark.parametrize("size", [-1, "8", None, True, 1.5])
def test_invalid_upload_sizes_rejected(chunks, size):
    assert chunks.post("/api/upload/init", json={"fileName": "new.txt", "fileSize": size}).status_code == 400


def test_empty_upload(chunks, root_dir):
    uid = start(chunks, size=0)
    response = chunks.post("/api/upload/complete", json={"uploadId": uid})
    assert response.status_code == 200
    assert (root_dir / response.json["path"]).read_bytes() == b""


def test_short_last_chunk(chunks, root_dir):
    uid = start(chunks, size=6)
    assert send_chunk(chunks, uid, 1, b"ef").status_code == 200
    assert send_chunk(chunks, uid, 0, b"abcd").status_code == 200
    response = chunks.post("/api/upload/complete", json={"uploadId": uid})
    assert response.status_code == 200
    assert (root_dir / response.json["path"]).read_bytes() == b"abcdef"


def test_stale_cleanup_preserves_destination(chunks, root_dir):
    from datetime import datetime, timedelta
    import app.filer.routes as routes
    uid = start(chunks, "file.txt")
    routes._active_uploads[uid]["updated"] = datetime.now() - timedelta(days=2)
    with chunks.application.app_context():
        routes._cleanup_stale_uploads()
    assert uid not in routes._active_uploads
    assert not list(root_dir.glob(".filer-*.part"))
    assert (root_dir / "file.txt").read_text() == "hello world"


def test_completion_without_chunks_rejected(chunks, root_dir):
    uid = start(chunks)
    assert chunks.post("/api/upload/complete", json={"uploadId": uid}).status_code == 409
    assert not (root_dir / "uploaded.txt").exists()


def test_simultaneous_names_keep_both(chunks, root_dir):
    first = start(chunks, size=4)
    second = start(chunks, size=4)
    send_chunk(chunks, first, 0, b"aaaa")
    send_chunk(chunks, second, 0, b"bbbb")
    paths = [chunks.post("/api/upload/complete", json={"uploadId": uid}).json["path"]
             for uid in (first, second)]
    assert len(set(paths)) == 2
    assert [(root_dir / path).read_bytes() for path in paths] == [b"aaaa", b"bbbb"]


def test_snippets_escape_templates_and_html(client):
    payload = '{{7*7}}</pre><script>alert("test")</script>'
    response = client.post("/napkins/text", json={"title": payload, "content": payload})
    page = client.get(response.json["view_url"])
    assert page.status_code == 200
    assert b"{{7*7}}" in page.data
    assert b"&lt;script&gt;" in page.data
    assert b'<script>alert("test")</script>' not in page.data
    assert client.get(response.json["raw_url"]).data.decode() == payload
    assert b"/qt/" not in page.data


def test_returned_download_link(client):
    response = client.post("/napkins/upload", data={"file": (io.BytesIO(b"shared"), "share.txt")})
    with client.get(response.json["download_url"]) as download:
        assert download.status_code == 200
        assert download.data == b"shared"


def test_concurrent_snippets_preserve_metadata(app):
    def create(index):
        with app.test_client() as client:
            response = client.post("/napkins/text", json={"content": str(index)})
            assert response.status_code == 200
            return response.json["id"]
    with ThreadPoolExecutor(max_workers=8) as pool:
        ids = set(pool.map(create, range(24)))
    listed = app.test_client().get("/napkins/api/items").json["items"]
    assert {item["id"] for item in listed} == ids


def test_concurrent_trash_preserves_metadata(app, root_dir):
    names = [f"delete-{index}.txt" for index in range(24)]
    for name in names:
        (root_dir / name).write_text(name)
    def delete(name):
        with app.test_client() as client:
            result = client.delete("/api/file", json={"paths": [name]}).json
            assert result["deleted"] == [name]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(delete, names))
    items = app.test_client().get("/api/trash/items").json["items"]
    assert {item["original_path"] for item in items} == set(names)


def test_metadata_transaction_across_processes(tmp_path):
    filename = tmp_path / "metadata.json"
    script = '''
import json, sys, time
from pathlib import Path
from app.storage import MetadataLock, save_json
path = Path(sys.argv[1])
lock = MetadataLock(lambda: path)
for index in range(8):
    with lock.transaction():
        data = json.loads(path.read_text()) if path.exists() else {}
        time.sleep(0.01)
        data[sys.argv[2] + str(index)] = index
        save_json(path, data)
'''
    processes = [subprocess.Popen([sys.executable, "-c", script, str(filename), str(index)])
                 for index in range(3)]
    try:
        for process in processes:
            assert process.wait(timeout=30) == 0
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
    assert len(json.loads(filename.read_text())) == 24


def test_failed_metadata_replace_preserves_old_file(tmp_path, monkeypatch):
    from app.storage import save_json
    import app.storage as storage
    filename = tmp_path / "metadata.json"
    save_json(filename, {"old": True})
    def fail(*args):
        raise OSError("simulated write failure")
    monkeypatch.setattr(storage.os, "replace", fail)
    with pytest.raises(OSError):
        save_json(filename, {"new": True})
    assert json.loads(filename.read_text()) == {"old": True}
    assert list(tmp_path.iterdir()) == [filename]


def test_root_cannot_be_deleted(client, root_dir):
    result = client.delete("/api/file", json={"paths": [""]})
    assert result.json["deleted"] == []
    assert root_dir.exists()


def test_delete_uses_normalized_path(client, root_dir):
    response = client.delete("/api/file", json={"paths": ["/file.txt"]})
    assert response.json["deleted"] == ["/file.txt"]
    assert not (root_dir / "file.txt").exists()
    item = client.get("/api/trash/items").json["items"][0]
    assert item["original_path"] == "file.txt"


def test_server_defaults_are_local_and_debug_off():
    from server import parse_args
    args = parse_args([])
    assert args.host == "127.0.0.1"
    assert args.debug is False
    assert parse_args(["--production"]).production is True


@pytest.mark.parametrize("arguments", [
    ["--debug", "--host", "0.0.0.0"],
    ["--debug", "--production"],
])
def test_unsafe_debug_options_rejected(arguments):
    from server import parse_args
    with pytest.raises(SystemExit) as error:
        parse_args(arguments)
    assert error.value.code == 2
