"""Behavior and failure-path coverage for copying and ZIP extraction."""

import errno
import io
import stat
import zipfile
import zlib
from pathlib import Path

import pytest

import app.filer.operations as operations
from app.trash.service import trash_load_metadata, trash_restore


def transfer(client, source='file.txt', destination='copy.txt', **options):
    return client.post('/api/transfer', json={
        'items': [{'source': source, 'destination': destination}], **options,
    })


def make_zip(root_dir, entries=None):
    path = root_dir / 'test.zip'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in (entries or [('folder/a.txt', 'alpha'), ('b.txt', 'beta'), ('empty/', '')]):
            archive.writestr(name, content)
    return path


def extract(client, **options):
    return client.post('/api/archive/extract', json={'path': 'test.zip', 'destination': 'output', **options})


def test_copy_folder_preserves_tree_and_original(client, root_dir):
    response = transfer(client, 'subdir', 'copied')
    assert response.json['errors'] == []
    assert (root_dir / 'copied/nested.txt').read_text() == 'nested content'
    assert (root_dir / 'subdir/nested.txt').exists()


def test_duplicate_files_and_dotted_folders(client, root_dir):
    assert transfer(client, 'file.txt', 'file.txt', conflict='keep_both').json['errors'] == []
    assert (root_dir / 'file (1).txt').read_text() == 'hello world'
    (root_dir / 'photos.old').mkdir()
    assert transfer(client, 'photos.old', 'photos.old', conflict='keep_both').json['errors'] == []
    assert (root_dir / 'photos.old (1)').is_dir()


def test_skip_is_reported_and_does_not_modify_either_file(client, root_dir):
    response = transfer(client, destination='subdir/nested.txt')
    assert len(response.json['skipped']) == 1
    assert response.json['completed'] == []
    assert (root_dir / 'subdir/nested.txt').read_text() == 'nested content'
    assert (root_dir / 'file.txt').exists()


def test_replace_keeps_original_in_trash(client, root_dir):
    response = transfer(client, destination='subdir/nested.txt', conflict='replace')
    assert response.json['errors'] == []
    assert (root_dir / 'subdir/nested.txt').read_text() == 'hello world'
    items = trash_load_metadata()['items']
    assert len(items) == 1
    (root_dir / 'subdir/nested.txt').unlink()
    restored = trash_restore(next(iter(items)), root_dir)
    assert restored['success']
    assert any(path.read_text() == 'nested content' for path in (root_dir / 'subdir').glob('*.txt'))


def test_replace_whole_folder_does_not_merge(client, root_dir):
    transfer(client, 'empty_dir', 'subdir', conflict='replace')
    assert list((root_dir / 'subdir').iterdir()) == []
    assert len(trash_load_metadata()['items']) == 1


def test_failed_copy_does_not_trash_or_replace_destination(client, root_dir, monkeypatch):
    def fail(*args):
        raise OSError(errno.ENOSPC, 'full')
    monkeypatch.setattr(operations.shutil, 'copy2', fail)
    response = transfer(client, destination='subdir/nested.txt', conflict='replace')
    assert 'disk space' in response.json['errors'][0]['error']
    assert (root_dir / 'subdir/nested.txt').read_text() == 'nested content'
    assert not list(root_dir.glob('.filer-copy-*'))
    assert not trash_load_metadata()['items']


def test_failed_publication_restores_replaced_destination(client, root_dir, monkeypatch):
    original = Path.rename
    def fail_payload(self, destination):
        if self.name == 'payload':
            raise PermissionError(errno.EACCES, 'locked')
        return original(self, destination)
    monkeypatch.setattr(Path, 'rename', fail_payload)
    response = transfer(client, destination='subdir/nested.txt', conflict='replace')
    assert response.json['errors']
    assert (root_dir / 'subdir/nested.txt').read_text() == 'nested content'
    assert (root_dir / 'file.txt').exists()


def test_move_and_partial_failure(client, root_dir):
    response = client.post('/api/transfer', json={'action': 'move', 'items': [
        {'source': 'file.txt', 'destination': 'moved.txt'},
        {'source': 'missing.txt', 'destination': 'nope.txt'},
    ]})
    assert len(response.json['completed']) == len(response.json['errors']) == 1
    assert not (root_dir / 'file.txt').exists()
    assert (root_dir / 'moved.txt').read_text() == 'hello world'


@pytest.mark.parametrize('source,destination', [
    ('', 'copy'), ('subdir', 'subdir/inside'), ('subdir/nested.txt', 'subdir'),
    ('file.txt', '../outside'), ('file.txt', '.filer-hidden'), ('file.txt', 'missing/copy'),
    ('file.txt', 'file.txt'), ('file.txt', 'bad:name'),
])
def test_unsafe_or_invalid_transfer_is_rejected(client, root_dir, source, destination):
    response = transfer(client, source, destination, conflict='replace')
    assert response.json['errors']
    assert (root_dir / 'file.txt').read_text() == 'hello world'
    assert (root_dir / 'subdir/nested.txt').read_text() == 'nested content'


def test_copy_rejects_nested_link(client, root_dir):
    try:
        (root_dir / 'subdir/link').symlink_to(root_dir / 'file.txt')
    except OSError:
        pytest.skip('Creating symbolic links is unavailable')
    response = transfer(client, 'subdir', 'copy')
    assert response.json['errors']
    assert not (root_dir / 'copy').exists()
    assert not list(root_dir.glob('.filer-copy-*'))


def test_archive_listing_and_extraction(client, root_dir):
    make_zip(root_dir)
    response = client.get('/api/archive?path=test.zip')
    assert [entry['path'] for entry in response.json['entries']] == ['folder/a.txt', 'b.txt', 'empty/']
    response = extract(client)
    assert response.status_code == 200, response.json
    assert response.json['extracted'] == 2
    assert (root_dir / 'output/folder/a.txt').read_text() == 'alpha'
    assert (root_dir / 'output/empty').is_dir()
    assert not list(root_dir.glob('.filer-extract-*'))


@pytest.mark.parametrize('members,expected', [(['b.txt'], ['b.txt']), (['folder/'], ['folder/a.txt'])])
def test_extract_selected_entries(client, root_dir, members, expected):
    make_zip(root_dir, [('folder/', ''), ('folder/a.txt', 'alpha'), ('b.txt', 'beta')])
    response = extract(client, members=members)
    assert response.status_code == 200, response.json
    assert sorted(path.relative_to(root_dir / 'output').as_posix()
                  for path in (root_dir / 'output').rglob('*') if path.is_file()) == expected


@pytest.mark.parametrize('name', ['../escape', '/absolute', 'a\\b', 'C:/drive', 'a/../../escape', '.filer-secret', 'CON'])
def test_archive_rejects_unsafe_paths_before_writing(client, root_dir, name):
    make_zip(root_dir, [('good.txt', 'safe'), (name, 'bad')])
    if name == 'a\\b':
        path = root_dir / 'test.zip'
        path.write_bytes(path.read_bytes().replace(b'a/b', bytes([97, 92, 98])))
    assert client.get('/api/archive?path=test.zip').status_code == 400
    assert extract(client).status_code == 400
    assert not (root_dir / 'output').exists()
    assert not list(root_dir.glob('.filer-extract-*'))


@pytest.mark.parametrize('entries', [
    [('a.txt', 'one'), ('A.txt', 'two')], [('folder', 'file'), ('folder/a.txt', 'nested')],
])
def test_archive_rejects_ambiguous_entries(client, root_dir, entries):
    make_zip(root_dir, entries)
    assert extract(client).status_code == 400
    assert not (root_dir / 'output').exists()


def test_archive_rejects_links(client, root_dir):
    with zipfile.ZipFile(root_dir / 'test.zip', 'w') as archive:
        info = zipfile.ZipInfo('link')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, '../outside')
    assert extract(client).status_code == 400


def test_archive_limits_and_existing_destination(client, root_dir, monkeypatch):
    make_zip(root_dir)
    assert extract(client, destination='subdir').status_code == 409
    assert (root_dir / 'subdir/nested.txt').read_text() == 'nested content'
    monkeypatch.setattr(operations, 'MAX_ARCHIVE_ENTRIES', 1)
    assert extract(client).status_code == 400
    monkeypatch.setattr(operations, 'MAX_ARCHIVE_ENTRIES', 10000)
    monkeypatch.setattr(operations, 'MAX_EXTRACT_BYTES', 1)
    assert extract(client).status_code == 400


def test_corrupt_archive_leaves_no_output(client, root_dir):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_STORED) as archive:
        archive.writestr('a.txt', 'original bytes')
    (root_dir / 'test.zip').write_bytes(buffer.getvalue().replace(b'original bytes', b'corrupt! bytes'))
    assert extract(client).status_code == 400
    assert not (root_dir / 'output').exists()
    assert not list(root_dir.glob('.filer-extract-*'))


def test_decompression_failure_is_reported_without_partial_output(client, root_dir, monkeypatch):
    make_zip(root_dir)
    def fail(*args, **kwargs):
        raise zlib.error('invalid compressed data')
    monkeypatch.setattr(zipfile.ZipFile, 'open', fail)
    assert extract(client).status_code == 400
    assert not (root_dir / 'output').exists()
    assert not list(root_dir.glob('.filer-extract-*'))


@pytest.mark.parametrize('members', [[], ['missing'], 'a.txt', [42]])
def test_invalid_archive_selection_is_rejected(client, root_dir, members):
    make_zip(root_dir)
    assert extract(client, members=members).status_code == 400
    assert not (root_dir / 'output').exists()
