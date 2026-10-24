"""Failure-path coverage: no false success, lost originals, or RAM-sized archives."""

import errno
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

import app.filer.routes as routes


@pytest.fixture
def upload_client(client, monkeypatch):
    monkeypatch.setattr(routes, 'CHUNK_SIZE', 4)
    before = set(routes._active_uploads)
    yield client
    for uid in set(routes._active_uploads) - before:
        info = routes._active_uploads.pop(uid)
        info['path'].unlink(missing_ok=True)


def begin(client, name='new.txt', size=8):
    response = client.post('/api/upload/init', json={'fileName': name, 'fileSize': size})
    assert response.status_code == 200, response.json
    return response.json['uploadId']


def chunk(client, uid, index, data):
    return client.post('/api/upload/chunk', data={
        'uploadId': uid, 'chunkIndex': str(index), 'chunk': (io.BytesIO(data), 'chunk'),
    })


def test_upload_resumes_in_a_fresh_process_and_completion_is_idempotent(upload_client, app, root_dir):
    uid = begin(upload_client)
    assert chunk(upload_client, uid, 0, b'abcd').status_code == 200
    script = '''
import io, json, sys
from pathlib import Path
from app import create_app
app = create_app(Path(sys.argv[1]))
app.config['DATA_DIR'] = Path(sys.argv[2])
client = app.test_client()
uid = sys.argv[3]
status = client.post('/api/upload/status', json={'uploadId': uid})
assert status.json['received'] == [0], status.json
part = client.post('/api/upload/chunk', data={'uploadId': uid, 'chunkIndex': '1', 'chunk': (io.BytesIO(b'efgh'), 'chunk')})
assert part.status_code == 200, part.json
result = client.post('/api/upload/complete', json={'uploadId': uid})
assert result.status_code == 200, result.json
print(json.dumps(result.json))
'''
    process = subprocess.run([sys.executable, '-c', script, str(root_dir), str(app.config['DATA_DIR']), uid],
                             capture_output=True, text=True, timeout=30)
    assert process.returncode == 0, process.stderr
    assert (root_dir / 'new.txt').read_bytes() == b'abcdefgh'
    routes._active_uploads.pop(uid)
    repeated = upload_client.post('/api/upload/complete', json={'uploadId': uid})
    assert repeated.json == json.loads(process.stdout)
    assert not (root_dir / 'new (1).txt').exists()


def test_cancel_after_restart_preserves_existing_file(upload_client, app, root_dir):
    uid = begin(upload_client, name='file.txt')
    chunk(upload_client, uid, 0, b'abcd')
    routes._active_uploads.pop(uid)
    response = upload_client.post('/api/upload/cancel', json={'uploadId': uid})
    assert response.status_code == 200
    assert not list(root_dir.glob('.filer-*.part'))
    assert not (app.config['DATA_DIR'] / 'upload_sessions' / f'{uid}.json').exists()
    assert (root_dir / 'file.txt').read_text() == 'hello world'


def test_completed_rename_is_recovered_when_receipt_save_fails(upload_client, root_dir, monkeypatch):
    uid = begin(upload_client, size=4)
    chunk(upload_client, uid, 0, b'abcd')
    real_save = routes._save_upload
    def fail_receipt(uid, info):
        if info.get('completed'):
            raise OSError(errno.ENOSPC, 'disk full')
        real_save(uid, info)
    monkeypatch.setattr(routes, '_save_upload', fail_receipt)
    assert upload_client.post('/api/upload/complete', json={'uploadId': uid}).status_code == 507
    assert (root_dir / 'new.txt').read_bytes() == b'abcd'
    routes._active_uploads.pop(uid)
    monkeypatch.setattr(routes, '_save_upload', real_save)
    response = upload_client.post('/api/upload/status', json={'uploadId': uid})
    assert response.status_code == 200
    assert response.json['completed'] == 'new.txt'
    assert not (root_dir / 'new (1).txt').exists()


def test_publication_recovery_rejects_changed_destination(upload_client, root_dir, monkeypatch):
    uid = begin(upload_client, size=4)
    chunk(upload_client, uid, 0, b'abcd')
    real_save = routes._save_upload
    def fail_receipt(uid, info):
        if info.get('completed'):
            raise OSError(errno.ENOSPC, 'disk full')
        real_save(uid, info)
    monkeypatch.setattr(routes, '_save_upload', fail_receipt)
    upload_client.post('/api/upload/complete', json={'uploadId': uid})
    routes._active_uploads.pop(uid)
    monkeypatch.setattr(routes, '_save_upload', real_save)
    (root_dir / 'new.txt').write_bytes(b'xxxx')
    response = upload_client.post('/api/upload/status', json={'uploadId': uid})
    assert response.status_code == 409
    assert 'changed' in response.json['error']


def test_request_size_limit_returns_json_error(client, app):
    app.config['MAX_CONTENT_LENGTH'] = 16
    response = client.post('/api/file', json={'name': 'this-request-is-too-large.txt'})
    assert response.status_code == 413
    assert response.json['error']


def test_expired_disk_checkpoint_is_cleaned_after_restart(upload_client, app, root_dir):
    uid = begin(upload_client)
    info = routes._active_uploads.pop(uid)
    checkpoint = app.config['DATA_DIR'] / 'upload_sessions' / f'{uid}.json'
    data = json.loads(checkpoint.read_text())
    data['updated'] = '2000-01-01T00:00:00'
    checkpoint.write_text(json.dumps(data))
    begin(upload_client, name='other.txt')
    assert not info['path'].exists()
    assert not checkpoint.exists()


def test_checkpoint_write_failure_cleans_new_staging_file(upload_client, root_dir, monkeypatch):
    def full(*args, **kwargs):
        raise OSError(errno.ENOSPC, 'disk full')
    monkeypatch.setattr(routes, 'save_json', full)
    response = upload_client.post('/api/upload/init', json={'fileName': 'file.txt', 'fileSize': 8})
    assert response.status_code == 507
    assert 'disk space' in response.json['error']
    assert not list(root_dir.glob('.filer-*.part'))
    assert (root_dir / 'file.txt').read_text() == 'hello world'


def test_failed_chunk_is_not_acknowledged_and_can_be_retried(upload_client, root_dir, monkeypatch):
    uid = begin(upload_client, size=4)
    real_open = Path.open
    class FailingWriter:
        def __init__(self, handle):
            self.handle = handle
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.handle.close()
        def seek(self, offset):
            self.handle.seek(offset)
        def write(self, data):
            self.handle.write(data[:1])
            raise OSError(errno.ENOSPC, 'disk full')
    def open_file(path, mode='r', *args, **kwargs):
        handle = real_open(path, mode, *args, **kwargs)
        return FailingWriter(handle) if mode == 'r+b' and path.suffix == '.part' else handle
    monkeypatch.setattr(Path, 'open', open_file)
    assert chunk(upload_client, uid, 0, b'abcd').status_code == 507
    assert upload_client.post('/api/upload/status', json={'uploadId': uid}).json['received'] == []
    monkeypatch.setattr(Path, 'open', real_open)
    assert chunk(upload_client, uid, 0, b'abcd').status_code == 200
    assert upload_client.post('/api/upload/complete', json={'uploadId': uid}).status_code == 200
    assert (root_dir / 'new.txt').read_bytes() == b'abcd'


def test_failed_editor_save_preserves_original(client, root_dir, monkeypatch):
    import app.filesystem as filesystem
    def full(*args, **kwargs):
        raise OSError(errno.ENOSPC, 'disk full')
    monkeypatch.setattr(filesystem.os, 'replace', full)
    response = client.put('/api/file', json={'path': 'file.txt', 'content': 'replacement'})
    assert response.status_code == 507
    assert (root_dir / 'file.txt').read_text() == 'hello world'
    assert not list(root_dir.glob('.filer-edit-*'))


def test_small_upload_reports_errors_and_removes_partial_files(client, root_dir, monkeypatch):
    def full(*args):
        raise OSError(errno.ENOSPC, 'disk full')
    monkeypatch.setattr(routes.os, 'fsync', full)
    response = client.post('/api/upload', data={'files': (io.BytesIO(b'new data'), 'file.txt')})
    assert response.status_code == 200
    assert response.json['uploaded'] == []
    assert 'disk space' in response.json['errors'][0]['error']
    assert (root_dir / 'file.txt').read_text() == 'hello world'
    assert not list(root_dir.glob('.filer-small-*'))


@pytest.mark.parametrize('name', ['CON.txt', 'a:b.txt', 'name.', 'trailing ', 'a/b', '\0', None])
def test_invalid_names_return_json_errors(client, name):
    response = client.post('/api/file', json={'name': name})
    assert response.status_code == 400
    assert response.json['error']


def test_move_validation_does_not_abort_other_items(client, root_dir):
    response = client.post('/api/move', json={'items': [
        {'source': 'subdir', 'destination': 'subdir/inside/deeper'},
        {'source': '', 'destination': 'new-root'},
        {'source': 'file.txt', 'destination': 'empty_dir/file.txt'},
    ]})
    assert response.status_code == 200
    assert len(response.json['errors']) == 2
    assert len(response.json['moved']) == 1
    assert not (root_dir / 'subdir/inside').exists()
    assert (root_dir / 'empty_dir/file.txt').read_text() == 'hello world'


def test_delete_reports_partial_results_even_with_invalid_path(client):
    response = client.delete('/api/file', json={'paths': ['file.txt', '../outside']})
    assert response.status_code == 200
    assert response.json['deleted'] == ['file.txt']
    assert len(response.json['errors']) == 1


def test_locked_file_has_actionable_error(client, monkeypatch):
    error = PermissionError('locked')
    error.winerror = 32
    def locked(*args):
        raise error
    monkeypatch.setattr(routes, 'atomic_write_text', locked)
    response = client.put('/api/file', json={'path': 'file.txt', 'content': 'new'})
    assert response.status_code == 423
    assert 'in use' in response.json['error']


def test_trash_metadata_failure_rolls_back_file_move(client, root_dir, monkeypatch):
    import app.trash.service as trash
    def full(*args):
        raise OSError(errno.ENOSPC, 'disk full')
    monkeypatch.setattr(trash, 'trash_save_metadata', full)
    response = client.delete('/api/file', json={'paths': ['file.txt']})
    assert response.json['deleted'] == []
    assert response.json['errors']
    assert (root_dir / 'file.txt').read_text() == 'hello world'


def test_zip_uses_disk_storage_and_closes_it(client, monkeypatch):
    created = []
    real_file = routes.tempfile.TemporaryFile
    def temporary(*args, **kwargs):
        result = real_file(*args, **kwargs)
        created.append(result)
        return result
    monkeypatch.setattr(routes.tempfile, 'TemporaryFile', temporary)
    with client.get('/api/zip?paths=file.txt') as response:
        assert response.status_code == 200
        assert created and not created[0].closed
        assert int(response.headers['Content-Length']) == len(response.data)
    assert created[0].closed


def test_failed_zip_generation_closes_temporary_file(client, monkeypatch):
    created = []
    real_file = routes.tempfile.TemporaryFile
    def temporary(*args, **kwargs):
        result = real_file(*args, **kwargs)
        created.append(result)
        return result
    def full(*args, **kwargs):
        raise OSError(errno.ENOSPC, 'disk full')
    monkeypatch.setattr(routes.tempfile, 'TemporaryFile', temporary)
    monkeypatch.setattr(routes.zipfile.ZipFile, 'write', full)
    response = client.get('/api/zip?paths=file.txt')
    assert response.status_code == 507
    assert created[0].closed


def test_settings_disk_error_is_not_reported_as_success(client, monkeypatch):
    import app.settings.service as settings
    def full(*args):
        raise OSError(errno.ENOSPC, 'disk full')
    monkeypatch.setattr(settings, 'save_json', full)
    response = client.post('/settings/api', json={'theme': 'light'})
    assert response.status_code == 507
    assert client.get('/settings/api').json['theme'] == 'dark'


def test_napkins_metadata_failure_removes_uploaded_file(client, monkeypatch):
    import app.quicktransfer.routes as qt
    def full(*args):
        raise OSError(errno.ENOSPC, 'disk full')
    monkeypatch.setattr(qt, 'qt_save_metadata', full)
    response = client.post('/napkins/upload', data={'file': (io.BytesIO(b'upload'), 'sample.txt')})
    assert response.status_code == 507
    assert list(Path(qt.QT_UPLOAD_FOLDER).iterdir()) == []
