// Run with: node --test tests/frontend.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');

function harness() {
    const nodes = new Map();
    const listeners = new Map();
    const windowListeners = new Map();
    const urls = [];
    const storage = new Map();
    function element(id) {
        if (!nodes.has(id)) {
            const classes = new Set();
            nodes.set(id, {
                innerHTML: '', textContent: '', value: '', src: '', style: {},
                classList: {
                    add(...names) { names.forEach(name => classes.add(name)); },
                    remove(...names) { names.forEach(name => classes.delete(name)); },
                    contains(name) { return classes.has(name); },
                    toggle(name, force) {
                        if (force ?? !classes.has(name)) classes.add(name);
                        else classes.delete(name);
                    },
                },
                addEventListener() {}, setAttribute() {}, removeAttribute() {},
                focus() {}, select() {}, querySelector() { return element(id + '-child'); },
            });
        }
        return nodes.get(id);
    }
    const context = vm.createContext({
        console, URLSearchParams, performance, AbortController, FormData, Blob,
        window: { innerWidth: 500, addEventListener(event, callback) { windowListeners.set(event, callback); }, location: { pathname: '/', hash: '' } },
        document: {
            getElementById: element,
            addEventListener(event, callback) { listeners.set(event, callback); },
            querySelectorAll() { return []; },
        },
        localStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
        lucide: { createIcons() {} },
        history: { pushState(state, title, url) { urls.push(url); } },
        setTimeout() { return 1; }, clearTimeout() {},
    });
    vm.runInContext(source, context);
    return { context, element, urls, listeners, windowListeners, run: code => vm.runInContext(code, context) };
}

function handlers(html) {
    const entities = { amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' };
    return [...html.matchAll(/(?:onclick|onchange|oncontextmenu)="([^"]*)"/g)]
        .map(match => match[1].replace(/&(amp|quot|#39|lt|gt);/g, (_, key) => entities[key]));
}

function sample(name, directory = false) {
    return { name, path: name, isDirectory: directory, modified: '2026-01-01T12:00:00', size: 10 };
}

test('file actions round-trip apostrophes, quotes, and HTML characters', () => {
    const h = harness();
    const name = 'Bob\'s "notes" & <draft>.txt';
    const file = sample(name);
    const html = h.context.renderFileRow(file, null);
    assert(!html.includes('<draft>'));
    const received = [];
    for (const action of ['handleClick', 'downloadFile', 'deleteSingle', 'toggleSelect', 'showRenameModal']) {
        h.context[action] = (...args) => received.push(args);
    }
    h.context.event = { stopPropagation() {} };
    for (const handler of handlers(html)) h.run(handler);
    assert.equal(received.length, 5);
    assert(received.every(args => args[0] === name));
    assert(received.some(args => args[1] === name));
});

test('table, grid, breadcrumbs, and folder dialog produce valid handlers for quoted paths', () => {
    const h = harness();
    const name = 'Bob\'s "folder" & <draft>';
    h.run(`files = ${JSON.stringify([sample(name, true)])}; currentPath = ${JSON.stringify(name)};`);
    const htmls = [];
    h.run('mobileViewMode = "list"; renderFiles();');
    htmls.push(h.element('fileList').innerHTML);
    h.run('renderGridView();');
    htmls.push(h.element('fileList').innerHTML);
    h.run('renderBreadcrumbs();');
    htmls.push(h.element('breadcrumbs').innerHTML);
    htmls.push(h.context.renderFolderLevel([{ name, path: name, children: [] }]));
    const received = [];
    for (const action of ['handleClick', 'handleGridClick', 'handleRightClick', 'navigateTo',
        'toggleSelect', 'showRenameModal', 'deleteSingle', 'selectMoveDestination']) {
        h.context[action] = (...args) => received.push(args);
    }
    h.context.event = { stopPropagation() {} };
    for (const html of htmls) {
        assert(!html.includes('<draft>'));
        for (const handler of handlers(html)) h.run(handler);
    }
    assert(received.length >= 9);
    // handleRightClick takes the event first; every action must still receive the path.
    assert(received.every(args => args.includes(name) || args[0] === ''));
});

test('mobile gallery uses the clicked image path when other files precede it', () => {
    const h = harness();
    h.run(`files = ${JSON.stringify([sample('folder', true), sample('note.txt'), sample('photo.jpg')])}; renderGridView();`);
    h.run('handleGridClick("photo.jpg", false, 2);');
    assert.equal(h.element('imageViewerImg').src, '/api/view?path=photo.jpg');
    assert.equal(h.element('imageViewerCounter').textContent, '1 / 1');
    h.run('openImageViewer(99);');
    assert.equal(h.element('imageViewerImg').src, '/api/view?path=photo.jpg');
});

test('photo mode continues to filter text files after sorting', () => {
    const h = harness();
    h.run(`files = ${JSON.stringify([sample('folder', true), sample('note.txt'), sample('photo.jpg')])}; photoMode = true; sortColumn = null; renderGridView();`);
    assert(h.element('fileList').innerHTML.includes('photo.jpg'));
    assert(!h.element('fileList').innerHTML.includes('note.txt'));
});

test('file history URLs encode hash and question marks as part of the filename', async () => {
    const h = harness();
    await h.context.viewFile('folder/report#1?.pdf');
    assert.equal(h.urls[0], '/folder/report%231%3F.pdf');
    assert.equal(h.element('pdfFrame').src, '/api/view?path=folder%2Freport%231%3F.pdf');
});

test('dropped folders read all batches and preserve nested paths', async () => {
    const h = harness();
    const files = Array.from({ length: 150 }, (_, index) => ({
        isFile: true, file(resolve) { resolve({ name: `file${index}.txt` }); },
    }));
    let reads = 0;
    const folder = {
        name: 'folder', isDirectory: true,
        createReader() {
            return { readEntries(resolve) {
                reads++;
                resolve(reads === 1 ? files.slice(0, 100) : reads === 2 ? files.slice(100) : []);
            } };
        },
    };
    const collected = await h.context.collectDroppedEntries([folder]);
    assert.equal(reads, 3);
    assert.equal(collected.length, 150);
    assert.equal(collected[149].path, 'folder/file149.txt');
});

test('directory read failures reject instead of silently uploading a partial list', async () => {
    const h = harness();
    const folder = { name: 'locked', isDirectory: true, createReader() {
        return { readEntries(resolve, reject) { reject(new Error('permission denied')); } };
    } };
    await assert.rejects(h.context.collectDroppedEntries([folder]), /permission denied/);
});

test('mobile starts with all files visible and honors an explicitly saved photo filter', () => {
    const h = harness();
    h.run(`files = ${JSON.stringify([sample('notes.txt'), sample('photo.jpg')])}; initMobileViewMode(); renderFiles();`);
    assert(h.element('fileList').innerHTML.includes('notes.txt'));
    assert(h.element('photoModeNotice').classList.contains('hidden'));
    h.context.localStorage.getItem = key => key === 'filer-photoMode' ? 'true' : null;
    h.run('initMobileViewMode(); renderFiles();');
    assert(!h.element('fileList').innerHTML.includes('notes.txt'));
    assert(!h.element('photoModeNotice').classList.contains('hidden'));
});

test('grid selection reveals bulk actions and clear resets the visible selection', () => {
    const h = harness();
    h.run(`files = ${JSON.stringify([sample('notes.txt'), sample('photo.jpg')])}; renderFiles();`);
    h.context.toggleSelect('notes.txt');
    assert(!h.element('mobileSelectionBar').classList.contains('hidden'));
    assert.equal(h.element('mobileSelectionCount').textContent, '1 selected');
    assert(h.element('fileList').innerHTML.includes('aria-pressed="true"'));
    h.context.selectAllFiles();
    assert.equal(h.element('mobileSelectionCount').textContent, '2 selected');
    h.context.clearSelection();
    assert(h.element('mobileSelectionBar').classList.contains('hidden'));
    assert.equal(h.element('selectAll').checked, false);
});

test('photo mode select-all excludes hidden files and changing the filter clears selections', () => {
    const h = harness();
    h.run(`files = ${JSON.stringify([sample('notes.txt'), sample('photo.jpg')])}; photoMode = true; selectAllFiles();`);
    assert.equal(h.element('mobileSelectionCount').textContent, '1 selected');
    assert.equal(h.run('selectedFiles.has("notes.txt")'), false);
    assert.equal(h.run('selectedFiles.has("photo.jpg")'), true);
    h.context.togglePhotoMode();
    assert.equal(h.run('selectedFiles.size'), 0);
    assert(h.element('fileList').innerHTML.includes('notes.txt'));
});

test('grid headings follow the mobile breakpoint when the browser resizes', () => {
    const h = harness();
    h.run(`files = ${JSON.stringify([sample('notes.txt')])}; renderFiles();`);
    assert(h.element('fileListView').classList.contains('mobile-grid-active'));
    h.context.window.innerWidth = 900;
    h.windowListeners.get('resize')();
    assert(!h.element('fileListView').classList.contains('mobile-grid-active'));
    h.context.window.innerWidth = 390;
    h.windowListeners.get('resize')();
    assert(h.element('fileListView').classList.contains('mobile-grid-active'));
});

function fakeXHR(h, responses) {
    const requests = [];
    h.context.XMLHttpRequest = class {
        constructor() {
            this.events = {};
            this.upload = { addEventListener() {} };
        }
        addEventListener(event, callback) { this.events[event] = callback; }
        open(method, url) { this.url = url; }
        send() {
            requests.push(this);
            const response = responses.shift();
            assert(response, 'Unexpected upload request');
            queueMicrotask(() => {
                this.status = response.status ?? 200;
                this.responseText = JSON.stringify(response.body ?? {});
                this.events[response.event ?? 'load']();
            });
        }
        abort() { this.events.abort(); }
    };
    return requests;
}

test('small uploads reject HTTP 200 responses containing per-file errors', async () => {
    const h = harness();
    const messages = [];
    h.context.showToast = (message, type) => messages.push({ message, type });
    h.context.refreshFiles = async () => {};
    fakeXHR(h, [
        { body: { uploaded: [], errors: [{ error: 'Permission denied' }] } },
        { body: { uploaded: ['good.txt'], errors: [] } },
    ]);
    const uploader = h.run('new ChunkedUploader([], "")');
    uploader.files = [new File(['a'], 'bad.txt'), new File(['b'], 'good.txt')].map(file => ({ file, destPath: '' }));
    uploader.totalBytes = 2;
    await uploader.start();
    assert.equal(messages.at(-1).type, 'error');
    assert.match(messages.at(-1).message, /Uploaded 1 item\(s\); 1 failed/);
    assert.match(messages.at(-1).message, /Permission denied/);
    assert.equal(h.run('activeUploader'), null);
});

test('transient chunk failures retry with a bounded number of attempts', async () => {
    const h = harness();
    h.context.setTimeout = callback => { queueMicrotask(callback); return 1; };
    const requests = fakeXHR(h, [
        { event: 'error' }, { status: 503, body: { error: 'Unavailable' } }, { body: { received: true } },
    ]);
    const uploader = h.run('new ChunkedUploader([], "")');
    await uploader._sendChunk('id', new File(['abcd'], 'big.bin'), { index: 0, start: 0, end: 4 });
    assert.equal(requests.length, 3);
    assert.equal(uploader.activeXHRs.size, 0);
});

test('resuming an upload sends only missing chunks', async () => {
    const h = harness();
    const file = new File(['abcdefghijkl'], 'big.bin', { lastModified: 10 });
    const key = 'filer-upload-v1:' + JSON.stringify(['folder', file.name, file.size, file.lastModified]);
    h.context.localStorage.setItem(key, 'checkpoint-id');
    const requests = [];
    h.context.fetch = async url => {
        requests.push(url);
        const body = url.endsWith('/status') ? { received: [0, 2], chunkSize: 4, fileSize: 12 } : { success: true, path: 'big.bin' };
        return { ok: true, json: async () => body };
    };
    const uploader = h.run('new ChunkedUploader([], "")');
    const chunks = [];
    uploader._sendChunk = async (id, file, chunk) => chunks.push(chunk.index);
    await uploader._uploadChunked(file, 'folder');
    assert.deepEqual(chunks, [1]);
    assert.deepEqual(requests, ['/api/upload/status', '/api/upload/complete']);
    assert.equal(h.context.localStorage.getItem(key), null);
});

test('lost completion response is recovered without uploading a duplicate file', async () => {
    const h = harness();
    const file = new File(['abcd'], 'big.bin', { lastModified: 10 });
    const key = 'filer-upload-v1:' + JSON.stringify(['', file.name, file.size, file.lastModified]);
    h.context.localStorage.setItem(key, 'completed-id');
    const requests = [];
    h.context.fetch = async url => {
        requests.push(url);
        return { ok: true, json: async () => ({ completed: 'big.bin', received: [0], chunkSize: 4 }) };
    };
    await h.run('new ChunkedUploader([], "")')._uploadChunked(file, '');
    assert.deepEqual(requests, ['/api/upload/status']);
    assert.equal(h.context.localStorage.getItem(key), null);
});

test('an unacknowledged completion retains the checkpoint instead of reporting success', async () => {
    const h = harness();
    const file = new File(['abcd'], 'big.bin', { lastModified: 10 });
    const key = 'filer-upload-v1:' + JSON.stringify(['', file.name, file.size, file.lastModified]);
    h.context.localStorage.setItem(key, 'checkpoint-id');
    h.context.fetch = async url => ({ ok: true, json: async () => url.endsWith('/status')
        ? { received: [0], chunkSize: 4, fileSize: 4 } : {} });
    await assert.rejects(h.run('new ChunkedUploader([], "")')._uploadChunked(file, ''), /did not confirm/);
    assert.equal(h.context.localStorage.getItem(key), 'checkpoint-id');
});

test('cancelling during initialization removes the session once its ID arrives', async () => {
    const h = harness();
    h.context.showToast = () => {};
    const uploader = h.run('new ChunkedUploader([], "")');
    let initialized;
    const cancelled = [];
    uploader._json = (url, data) => {
        if (url.endsWith('/init')) return new Promise(resolve => { initialized = resolve; });
        cancelled.push(data.uploadId);
        return Promise.resolve({ success: true });
    };
    const uploading = uploader._uploadChunked(new File(['abcd'], 'big.bin'), '');
    await uploader.cancel();
    initialized({ uploadId: 'late-id', chunkSize: 4 });
    await uploading;
    assert.deepEqual(cancelled, ['late-id']);
    assert.equal(uploader.currentUploadId, null);
});

test('failed cancellation keeps the retry checkpoint and reports an error', async () => {
    const h = harness();
    const messages = [];
    h.context.showToast = (message, type) => messages.push({ message, type });
    const uploader = h.run('new ChunkedUploader([], "")');
    uploader.currentUploadId = 'retry-id';
    uploader.resumeKey = 'retry-key';
    uploader._remember('retry-id');
    uploader._json = async () => { throw new Error('Network error'); };
    await uploader.cancel();
    assert.equal(messages.at(-1).type, 'error');
    assert.equal(h.context.localStorage.getItem('retry-key'), 'retry-id');
});

test('native downloads do not fetch or buffer the file in JavaScript', async () => {
    const h = harness();
    let clicked = false;
    let href;
    h.context.document.createElement = () => ({
        set href(value) { href = value; }, click() { clicked = true; }, remove() {},
    });
    h.context.document.body = { appendChild() {} };
    h.context.showToast = () => {};
    h.context.fetch = () => { throw new Error('Native download must not buffer through fetch'); };
    await h.run('new StreamDownloader("folder/big.bin")').start();
    assert(clicked);
    assert.equal(href, '/api/download?path=folder%2Fbig.bin');
    assert.equal(h.run('activeDownloader'), null);
});

test('failed streamed downloads abort the destination writer and release the reader', async () => {
    const h = harness();
    const calls = { abort: 0, close: 0, release: 0 };
    h.context.window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write: async () => {}, close: async () => calls.close++, abort: async () => calls.abort++,
    }) });
    let reads = 0;
    h.context.fetch = async () => ({ ok: true, headers: { get: () => '8' }, body: { getReader: () => ({
        read: async () => {
            if (reads++) throw new Error('Connection lost');
            return { done: false, value: new Uint8Array(4) };
        },
        cancel: async () => {}, releaseLock: () => calls.release++,
    }) } });
    const messages = [];
    h.context.showToast = (message, type) => messages.push(type);
    await h.run('new StreamDownloader("big.bin")').start();
    assert.equal(calls.abort, 1);
    assert.equal(calls.close, 0);
    assert.equal(calls.release, 1);
    assert.equal(messages.at(-1), 'error');
});

test('delete and move partial failures produce error messages instead of success toasts', async () => {
    const h = harness();
    const messages = [];
    h.context.showToast = (message, type) => messages.push({ message, type });
    h.context.refreshWithFailedSelection = async () => {};
    h.context.api = async () => ({ deleted: ['good.txt'], errors: [{ path: 'bad.txt', error: 'Locked' }] });
    await h.context.deleteFiles(['good.txt', 'bad.txt']);
    assert.equal(messages.at(-1).type, 'error');
    assert.match(messages.at(-1).message, /Deleted 1 item\(s\); 1 failed: Locked/);
    h.run('selectedFiles = new Set(["bad.txt"]);');
    h.context.api = async () => ({ moved: [], errors: [{ source: 'bad.txt', error: 'Destination exists' }] });
    await h.context.moveSelected();
    assert.equal(messages.at(-1).type, 'error');
    assert.match(messages.at(-1).message, /Destination exists/);
});

test('settings HTTP failures retain the previous settings and report failure', async () => {
    const h = harness();
    const html = fs.readFileSync(path.join(__dirname, '../templates/settings.html'), 'utf8');
    const script = html.slice(html.indexOf('    let currentSettings'), html.indexOf('    // Toast'));
    h.run(script);
    const messages = [];
    let applied = false;
    h.context.applySettings = () => { applied = true; };
    h.context.showToast = (message, type) => messages.push(type);
    h.context.fetch = async () => ({ ok: false, status: 507, json: async () => ({ error: 'Not enough disk space' }) });
    await h.context.setSetting('theme', 'light');
    assert.equal(h.run('currentSettings.theme'), 'dark');
    assert.equal(applied, false);
    assert.equal(messages.at(-1), 'error');
});

test('clipboard snapshots selection and paste opens the current folder with keep-both', async () => {
    const h = harness();
    h.context.showToast = () => {};
    h.run('selectedFiles = new Set(["file.txt"]); currentPath = "subdir";');
    h.context.setFileClipboard('copy');
    h.run('selectedFiles.clear();');
    h.context.api = async () => ({ folders: [] });
    await h.context.pasteFiles();
    assert.deepEqual(Array.from(h.run('pendingTransfer.paths')), ['file.txt']);
    assert.equal(h.run('pendingTransfer.action'), 'copy');
    assert.equal(h.run('moveDestination'), 'subdir');
    assert.equal(h.element('transferConflict').value, 'keep_both');
});

test('cut removes only completed items from clipboard and preserves skipped and failed selections', async () => {
    const h = harness();
    h.context.showToast = () => {};
    h.context.reportOperationResult = () => {};
    let retained;
    h.context.refreshWithFailedSelection = async paths => { retained = paths; };
    h.run('fileClipboard = { action: "move", paths: ["a", "b", "c"] }; pendingTransfer = { ...fileClipboard };');
    // The picker stores a snapshot under paths, as does the clipboard.
    h.element('transferConflict').value = 'skip';
    h.context.api = async () => ({ completed: [{ source: 'a' }], skipped: [{ source: 'b' }], errors: [{ source: 'c', error: 'Locked' }] });
    await h.context.moveSelected();
    assert.deepEqual(Array.from(h.run('fileClipboard.paths')), ['b', 'c']);
    assert.deepEqual(Array.from(retained).sort(), ['b', 'c']);
    assert.equal(h.element('transferSubmit').disabled, false);
});

test('replace requires confirmation before sending a transfer', async () => {
    const h = harness();
    h.run('selectedFiles = new Set(["file.txt"]);');
    h.element('transferConflict').value = 'replace';
    let calls = 0;
    h.context.api = async () => { calls++; };
    h.context.showConfirmDialog = async () => false;
    await h.context.moveSelected();
    assert.equal(calls, 0);
});

test('ZIP browser escapes entry names and defaults to a separate extraction folder', async () => {
    const h = harness();
    h.context.api = async () => ({ entries: [{ path: '<img src=x onerror=alert(1)>.txt', size: 4, isDirectory: false }] });
    await h.context.browseArchive('folder/example.ZIP');
    assert(!h.element('archiveEntries').innerHTML.includes('<img'));
    assert(h.element('archiveEntries').innerHTML.includes('&lt;img'));
    assert.equal(h.element('archiveDestination').value, 'folder/example extracted');
    assert.equal(h.element('extractSubmit').disabled, false);
});

test('extraction sends only selected members and refreshes after success', async () => {
    const h = harness();
    h.run('archivePath = "test.zip"; archiveEntries = [{path:"one.txt"}, {path:"two.txt"}];');
    h.element('archiveDestination').value = 'output';
    h.context.document.querySelectorAll = () => [
        { checked: false, dataset: { index: '0' } }, { checked: true, dataset: { index: '1' } },
    ];
    let payload;
    let refreshed = false;
    h.context.api = async (url, options) => {
        payload = JSON.parse(options.body);
        return { extracted: 1, destination: 'output' };
    };
    h.context.refreshFiles = async () => { refreshed = true; };
    h.context.showToast = () => {};
    await h.context.extractArchive();
    assert.deepEqual(payload.members, ['two.txt']);
    assert.equal(refreshed, true);
    assert.equal(h.run('archiveBusy'), false);
});

function dirtyEditor(h) {
    h.run('viewMode = "file"; currentViewingFile = {path:"notes.txt", name:"notes.txt"};');
    h.element('fileContent').value = 'original';
    h.context.enableEditMode();
    h.element('fileContent').value = 'draft';
}

test('cancelled breadcrumb and direct file navigation preserve a dirty draft', async () => {
    const h = harness();
    dirtyEditor(h);
    let calls = 0;
    h.context.showConfirmDialog = async () => false;
    h.context.api = async () => { calls++; };
    await h.context.navigateTo('');
    await h.context.viewFile('another.txt');
    assert.equal(calls, 0);
    assert.equal(h.element('fileContent').value, 'draft');
    assert.equal(h.run('viewMode'), 'file');
    assert.equal(h.context.hasUnsavedChanges(), true);
});

test('unchanged and reverted text do not warn; refresh with a draft does', async () => {
    const h = harness();
    dirtyEditor(h);
    let prevented = false;
    const event = { preventDefault() { prevented = true; } };
    h.windowListeners.get('beforeunload')(event);
    assert.equal(prevented, true);
    assert.equal(event.returnValue, '');
    h.element('fileContent').value = 'original';
    assert.equal(h.context.hasUnsavedChanges(), false);
    assert.equal(await h.context.allowNavigation(), true);
});

test('CodeMirror drafts compare against the editor baseline', () => {
    const h = harness();
    dirtyEditor(h);
    h.run('useCodeMirror = true; codeMirrorEditor = { getValue: () => "changed code" };');
    assert.equal(h.context.hasUnsavedChanges(), true);
    h.run('codeMirrorEditor.getValue = () => "original";');
    assert.equal(h.context.hasUnsavedChanges(), false);
});

test('saving only clears the exact saved draft and failures preserve dirty state', async () => {
    const h = harness();
    dirtyEditor(h);
    h.context.showToast = () => {};
    h.context.api = async () => { throw new Error('disk full'); };
    await h.context.saveCurrentFile();
    assert.equal(h.context.hasUnsavedChanges(), true);
    h.context.api = async () => { h.element('fileContent').value = 'newer draft'; };
    await h.context.saveCurrentFile();
    assert.equal(h.context.hasUnsavedChanges(), true);
    h.context.api = async () => ({});
    await h.context.saveCurrentFile();
    assert.equal(h.context.hasUnsavedChanges(), false);
});

test('cancelled browser Back restores history position without reloading the draft', async () => {
    const h = harness();
    dirtyEditor(h);
    h.run('historyIndex = 3;');
    h.context.showConfirmDialog = async () => false;
    let delta;
    h.context.history.go = value => { delta = value; };
    await h.windowListeners.get('popstate')({ state: { filerIndex: 2 } });
    assert.equal(delta, 1);
    assert.equal(h.run('restoringHistory'), true);
    await h.windowListeners.get('popstate')({ state: { filerIndex: 3 } });
    assert.equal(h.run('restoringHistory'), false);
    assert.equal(h.element('fileContent').value, 'draft');
});

test('search view clears stale file breadcrumbs and closing reloads its directory', async () => {
    const h = harness();
    h.run('currentPath = "Documents"; currentViewingFile = {path:"other/file.txt"}; selectedFiles.add("old.txt");');
    h.context.showSearchView();
    assert(!h.element('breadcrumbs').innerHTML.includes('file.txt'));
    assert(h.element('breadcrumbs').innerHTML.includes('Documents'));
    assert.equal(h.run('currentViewingFile'), null);
    h.context.window.location.pathname = '/Documents';
    h.context.window.location.search = '?q=notes';
    const calls = [];
    h.context.api = async url => { calls.push(url); return {path:'Documents', items:[sample('fresh.txt')]}; };
    await h.context.closeSearch();
    assert.deepEqual(calls, ['/api/files?path=Documents']);
    assert.equal(h.run('files[0].name'), 'fresh.txt');
    assert.equal(h.urls.at(-1), '/Documents');
    assert.equal(h.run('viewMode'), 'list');
});
