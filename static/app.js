// State
let currentPath = '';
let files = [];
let selectedFiles = new Set();
let currentViewingFile = null;
let newItemIsFolder = false;
let renamingPath = null;
let moveDestination = '';
let fileClipboard = null;
let pendingTransfer = null;
let transferBusy = false;
let archivePath = null;
let archiveEntries = [];
let archiveBusy = false;
let expandedFolders = new Set();
let viewMode = 'list'; // 'list', 'file', or 'search'
let codeMirrorEditor = null; // CodeMirror instance
let useCodeMirror = false; // Whether current file uses CodeMirror
let sortColumn = 'name'; // Current sort column (null = neutral/no sort)
let sortAscending = true; // Sort direction
let editorBaseline = null;
let editorLocation = '';
let historyIndex = 0;
let restoringHistory = false;

function editorContent() {
    return useCodeMirror && codeMirrorEditor
        ? codeMirrorEditor.getValue() : document.getElementById('fileContent').value;
}

function hasUnsavedChanges() {
    return editorBaseline !== null && viewMode === 'file' && currentViewingFile
        && editorContent() !== editorBaseline;
}

async function allowNavigation() {
    return !hasUnsavedChanges() || await showConfirmDialog({
        title: 'Discard unsaved changes?',
        message: 'Your edits have not been saved. Leave this file and discard them?',
        confirmText: 'Discard changes'
    });
}

function pushNavigationState(state, title, url) {
    history.pushState({ ...state, filerIndex: ++historyIndex }, title, url);
}

window.addEventListener('beforeunload', event => {
    if (hasUnsavedChanges()) {
        event.preventDefault();
        event.returnValue = '';
    }
});

// Preview thumbnail sizes per scale setting
const PREVIEW_SIZES = {
    sm: { thumb: 40, icon: 28 },
    md: { thumb: 64, icon: 40 },
    lg: { thumb: 96, icon: 56 }
};

// Mobile grid view
let mobileViewMode = 'grid'; // 'grid' or 'list' (mobile only)
let photoMode = false; // Photo Mode (mobile only)
let currentImageIndex = 0;
let currentFolderImages = [];

// Check if mobile
function isMobile() {
    return window.innerWidth < 640;
}

// Toggle mobile view mode (grid/list)
function toggleMobileViewMode() {
    mobileViewMode = localStorage.getItem('filer-mobileView') || 'grid';
    mobileViewMode = mobileViewMode === 'grid' ? 'list' : 'grid';
    localStorage.setItem('filer-mobileView', mobileViewMode);
    updateViewToggleIcon();
    renderFiles();
}

// Update view toggle icon
function updateViewToggleIcon() {
    const icon = document.getElementById('viewToggleIcon');
    if (icon) {
        icon.setAttribute('data-lucide', mobileViewMode === 'grid' ? 'list' : 'layout-grid');
        const label = mobileViewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view';
        const button = document.getElementById('viewToggleBtn');
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        lucide.createIcons();
    }
}

// Toggle Photo Mode
function togglePhotoMode() {
    photoMode = !photoMode;
    selectedFiles.clear();
    localStorage.setItem('filer-photoMode', photoMode ? 'true' : 'false');
    updatePhotoModeIcon();
    renderFiles();
    updateToolbar();
}

// Update Photo Mode icon
function updatePhotoModeIcon() {
    const button = document.getElementById('photoModeBtn');
    if (button) {
        button.classList.toggle('bg-blue-600', photoMode);
        button.setAttribute('aria-pressed', String(photoMode));
        const label = photoMode ? 'Show all files' : 'Show photos only';
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
    }
    document.getElementById('photoModeNotice').classList.toggle('hidden', !photoMode);
}

// Initialize mobile view mode
function initMobileViewMode() {
    mobileViewMode = localStorage.getItem('filer-mobileView') || 'grid';
    // Show all files by default; honor an explicitly saved photo-only preference.
    const savedPhotoMode = localStorage.getItem('filer-photoMode');
    photoMode = savedPhotoMode === 'true';
    updateViewToggleIcon();
    updatePhotoModeIcon();
}

// Wait for CodeMirror to load
function waitForCodeMirror(callback, maxAttempts = 20) {
    if (window.CodeMirror) {
        callback();
    } else if (maxAttempts > 0) {
        setTimeout(() => waitForCodeMirror(callback, maxAttempts - 1), 100);
    } else {
        console.warn('CodeMirror failed to load, using fallback textarea');
        callback();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    waitForCodeMirror(() => {
        initializeFromUrl();
        setupTabSupport();
    });
});

// Fix for Safari back button bfcache issue
window.addEventListener('pageshow', (event) => {
    // If page is loaded from bfcache, reinitialize from URL
    if (event.persisted) {
        initializeFromUrl();
    }
});

// Prevent bfcache issues by adding unload handler
window.addEventListener('unload', () => {
    // Clean up state
});

// Enable Tab key in the editor
function setupTabSupport() {
    const textarea = document.getElementById('fileContent');

    textarea.addEventListener('keydown', function(e) {
        if (e.key === 'Tab') {
            e.preventDefault();

            const start = this.selectionStart;
            const end = this.selectionEnd;
            const value = this.value;

            // Insert tab character
            this.value = value.substring(0, start) + '\t' + value.substring(end);

            // Move cursor after the tab
            this.selectionStart = this.selectionEnd = start + 1;
        }
    });
}

// Determine if file should use CodeMirror
function shouldUseCodeMirror(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const supportedExts = [
        'js', 'jsx', 'ts', 'tsx', 'json', 'jsonc',
        'py', 'pyw', 'html', 'htm', 'css', 'scss', 'sass',
        'xml', 'svg', 'md', 'markdown', 'yaml', 'yml',
        'sh', 'bash'
    ];
    return supportedExts.includes(ext);
}

// Get CodeMirror mode for file
function getCodeMirrorMode(filename) {
    const ext = filename.split('.').pop().toLowerCase();

    const modeMap = {
        'js': 'javascript',
        'jsx': 'javascript',
        'ts': 'javascript',
        'tsx': 'javascript',
        'json': 'javascript',
        'jsonc': 'javascript',
        'py': 'python',
        'pyw': 'python',
        'html': 'htmlmixed',
        'htm': 'htmlmixed',
        'css': 'css',
        'scss': 'css',
        'sass': 'css',
        'xml': 'xml',
        'svg': 'xml',
        'md': 'markdown',
        'markdown': 'markdown',
        'yaml': 'yaml',
        'yml': 'yaml',
        'sh': 'shell',
        'bash': 'shell'
    };

    return modeMap[ext] || 'text';
}

// Initialize CodeMirror editor
function initCodeMirror(content, readOnly = true) {
    const container = document.getElementById('codeMirrorEditor');

    if (!window.CodeMirror) {
        console.error('CodeMirror not loaded');
        return null;
    }

    try {
        // Destroy existing editor
        destroyCodeMirror();

        // Get mode
        const mode = getCodeMirrorMode(currentViewingFile.name);

        // Create editor directly in container
        codeMirrorEditor = CodeMirror(container, {
            value: content,
            mode: mode,
            theme: 'monokai',
            lineNumbers: true,
            lineWrapping: true,
            readOnly: readOnly,
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: true,
            autoCloseBrackets: true,
            matchBrackets: true,
            cursorBlinkRate: readOnly ? -1 : 530 // Hide cursor blink in read-only
        });

        // Add read-only class for styling
        if (readOnly) {
            codeMirrorEditor.getWrapperElement().classList.add('cm-readonly');
            container.classList.remove('edit-mode');
        } else {
            codeMirrorEditor.getWrapperElement().classList.remove('cm-readonly');
            container.classList.add('edit-mode');
        }

        // Refresh to ensure proper rendering
        setTimeout(() => {
            if (codeMirrorEditor) {
                codeMirrorEditor.refresh();
            }
        }, 10);

        console.log('CodeMirror initialized with mode:', mode);
        return codeMirrorEditor;
    } catch (error) {
        console.error('Failed to initialize CodeMirror:', error);
        return null;
    }
}

// Destroy CodeMirror editor
function destroyCodeMirror() {
    const container = document.getElementById('codeMirrorEditor');
    if (container) {
        container.innerHTML = '';
    }
    codeMirrorEditor = null;
}

// Parse line number from URL hash (#L36 or #L36-38)
function parseLineHash(hash) {
    if (!hash) return null;

    const match = hash.match(/^#L(\d+)(?:-(\d+))?$/);
    if (!match) return null;

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;

    return { start, end };
}

// Highlight lines in CodeMirror
function highlightLines(startLine, endLine) {
    if (!codeMirrorEditor) return;

    // Clear any existing highlights
    for (let i = 0; i < codeMirrorEditor.lineCount(); i++) {
        codeMirrorEditor.removeLineClass(i, 'background', 'highlighted-line');
    }

    // Add highlights (CodeMirror uses 0-based line numbers)
    for (let i = startLine - 1; i <= endLine - 1; i++) {
        if (i >= 0 && i < codeMirrorEditor.lineCount()) {
            codeMirrorEditor.addLineClass(i, 'background', 'highlighted-line');
        }
    }
}

// Scroll to line in CodeMirror
function scrollToLine(lineNum) {
    if (!codeMirrorEditor) return;

    // CodeMirror uses 0-based line numbers
    const line = lineNum - 1;
    if (line >= 0 && line < codeMirrorEditor.lineCount()) {
        // Scroll line to center of view
        const coords = codeMirrorEditor.charCoords({line: line, ch: 0}, 'local');
        const scrollInfo = codeMirrorEditor.getScrollInfo();
        const lineHeight = codeMirrorEditor.defaultTextHeight();
        const targetScroll = coords.top - (scrollInfo.clientHeight / 2) + (lineHeight / 2);

        codeMirrorEditor.scrollTo(null, Math.max(0, targetScroll));
    }
}

// Initialize view from current URL
async function initializeFromUrl() {
    historyIndex = history.state?.filerIndex ?? 0;
    history.replaceState({ ...history.state, filerIndex: historyIndex }, '', window.location.href);
    // Decode the URL path first (handles spaces like %20 -> space)
    const path = decodeURIComponent(window.location.pathname.replace(/^\/+|\/+$/g, ''));
    const urlParams = new URLSearchParams(window.location.search);
    const searchQuery = urlParams.get('q');

    if (searchQuery) {
        // URL has search query - load the directory first, then search
        currentPath = path;
        await navigateTo(path, false);
        document.getElementById('searchInput').value = searchQuery;
        await executeSearchFromUrl(searchQuery);
    } else {
        // Normal navigation
        await navigateTo(path, false);
    }
}

// Handle browser back/forward buttons
window.addEventListener('popstate', async (e) => {
    if (restoringHistory) {
        restoringHistory = false;
        return;
    }
    const targetIndex = e.state?.filerIndex;
    if (!await allowNavigation()) {
        if (Number.isInteger(targetIndex) && targetIndex !== historyIndex) {
            restoringHistory = true;
            history.go(historyIndex - targetIndex);
        } else {
            pushNavigationState({ path: currentViewingFile.path, type: 'file' }, '', editorLocation);
        }
        return;
    }
    if (Number.isInteger(targetIndex)) historyIndex = targetIndex;
    // Decode the URL path first (handles spaces like %20 -> space)
    const path = decodeURIComponent(window.location.pathname.replace(/^\/+|\/+$/g, ''));
    const urlParams = new URLSearchParams(window.location.search);
    const searchQuery = urlParams.get('q');

    if (searchQuery) {
        // Restore search view
        currentPath = path;
        document.getElementById('searchInput').value = searchQuery;
        await executeSearchFromUrl(searchQuery);
    } else {
        // Clear search input when going back to non-search view
        document.getElementById('searchInput').value = '';
        await navigateTo(path, false, true);
    }
});

// Handle hash changes for line highlighting
window.addEventListener('hashchange', () => {
    if (viewMode === 'file' && useCodeMirror && codeMirrorEditor) {
        const lineRange = parseLineHash(window.location.hash);
        if (lineRange) {
            highlightLines(lineRange.start, lineRange.end);
            scrollToLine(lineRange.start);
        }
    }
});

// Navigate to a path (auto-detect file vs directory)
async function navigateTo(path, pushHistory = true, discardApproved = false) {
    if (!discardApproved && !await allowNavigation()) return;
    // Clear search state when navigating
    document.getElementById('searchInput').value = '';
    document.getElementById('searchResultsView').classList.add('hidden');

    // First try to load as directory
    try {
        const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
        // It's a directory
        currentPath = data.path;
        files = data.items;
        selectedFiles.clear();
        viewMode = 'list';
        currentViewingFile = null;
        editorBaseline = null;
        // Reset sort state to neutral
        sortColumn = null;
        sortAscending = true;

        const newUrl = fileUrlPath(currentPath || '');
        if (pushHistory && window.location.pathname + (window.location.search || '') + (window.location.hash || '') !== newUrl) {
            pushNavigationState({ path: currentPath, type: 'dir' }, '', newUrl);
        }

        showListView();
        renderBreadcrumbs();
        renderFiles();
        updateToolbar();
    } catch (err) {
        // Maybe it's a file, try loading as file
        try {
            await viewFile(path, pushHistory, null, true);
        } catch (fileErr) {
            // Neither a valid directory nor file — redirect to root
            showToast(`Not found: /${path}`, 'error');
            if (currentPath !== '' || viewMode !== 'list') {
                history.replaceState({ path: '', type: 'dir', filerIndex: historyIndex }, '', '/');
                await navigateTo('', false);
            }
        }
    }
}

// API helpers
async function api(endpoint, options = {}) {
    const response = await fetch(endpoint, options);
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(error.error || error.message || 'Request failed');
    }
    return response.json();
}

// Show/hide views
function showListView() {
    document.getElementById('fileListView').classList.remove('hidden');
    document.getElementById('fileViewerView').classList.add('hidden');
    document.getElementById('toolbar').classList.remove('hidden');
    document.getElementById('breadcrumbsBar').classList.remove('hidden');
    // Clear PDF iframe and image to free memory
    document.getElementById('pdfFrame').src = '';
    document.getElementById('imageFrame').src = '';
    document.getElementById('imageViewer').classList.add('hidden');
    viewMode = 'list';
}

function showFileView() {
    document.getElementById('fileListView').classList.add('hidden');
    document.getElementById('fileViewerView').classList.remove('hidden');
    document.getElementById('toolbar').classList.add('hidden');
    // Keep breadcrumbs visible in file view for navigation
    viewMode = 'file';
    lucide.createIcons();
}

// Check if file is a PDF
function isPdf(filename) {
    return filename.toLowerCase().endsWith('.pdf');
}

// Check if file is an image
function isImage(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'svg', 'bmp', 'webp', 'ico'].includes(ext);
}

// View a file
async function viewFile(path, pushHistory = true, lineRange = null, discardApproved = false) {
    if (!discardApproved && !await allowNavigation()) return;
    const fileName = path.split('/').pop();
    if (fileName.toLowerCase().endsWith('.zip')) {
        await browseArchive(path);
        return;
    }

    // Update current path context (parent folder)
    const pathParts = path.split('/');
    pathParts.pop();
    currentPath = pathParts.join('/');

    // Parse line range from hash if not provided
    if (!lineRange && window.location.hash) {
        lineRange = parseLineHash(window.location.hash);
    }

    // Update URL
    let newUrl = fileUrlPath(path);
    if (lineRange) {
        newUrl += '#L' + lineRange.start + (lineRange.end !== lineRange.start ? '-' + lineRange.end : '');
    }
    if (pushHistory && window.location.pathname + window.location.hash !== newUrl) {
        pushNavigationState({ path: path, type: 'file', lineRange }, '', newUrl);
    }

    // Reset to view mode for new file
    resetViewMode();

    // Handle PDF files separately (no need to fetch content)
    if (isPdf(fileName)) {
        currentViewingFile = { path, name: fileName, isPdf: true };

        renderBreadcrumbs(fileName);
        document.getElementById('viewerFileName').textContent = fileName;
        document.getElementById('viewerFileMeta').textContent = 'PDF Document';

        document.getElementById('fileContentWrapper').classList.add('hidden');
        document.getElementById('binaryFileMessage').classList.add('hidden');
        document.getElementById('pdfViewer').classList.remove('hidden');
        document.getElementById('editFileBtn').classList.add('hidden');
        document.getElementById('saveFileBtn').classList.add('hidden');

        // Set PDF iframe source (use view endpoint for inline display)
        document.getElementById('pdfFrame').src = `/api/view?path=${encodeURIComponent(path)}`;

        showFileView();
        return;
    }

    // Handle image files separately (no need to fetch content)
    if (isImage(fileName)) {
        currentViewingFile = { path, name: fileName, isImage: true };

        renderBreadcrumbs(fileName);
        document.getElementById('viewerFileName').textContent = fileName;
        document.getElementById('viewerFileMeta').textContent = 'Image';

        document.getElementById('fileContentWrapper').classList.add('hidden');
        document.getElementById('binaryFileMessage').classList.add('hidden');
        document.getElementById('pdfViewer').classList.add('hidden');
        document.getElementById('imageViewer').classList.remove('hidden');
        document.getElementById('editFileBtn').classList.add('hidden');
        document.getElementById('saveFileBtn').classList.add('hidden');

        document.getElementById('imageFrame').src = `/api/view?path=${encodeURIComponent(path)}`;
        document.getElementById('imageFrame').alt = fileName;

        showFileView();
        return;
    }

    // Fetch file content for non-PDF files
    const data = await api(`/api/file?path=${encodeURIComponent(path)}`);
    currentViewingFile = data;

    // Update breadcrumbs to show file path
    renderBreadcrumbs(data.name);

    // Render file viewer
    document.getElementById('viewerFileName').textContent = data.name;
    document.getElementById('viewerFileMeta').textContent = `${formatSize(data.size)} • Modified ${formatDate(data.modified)}`;

    // Hide PDF and image viewers
    document.getElementById('pdfViewer').classList.add('hidden');
    document.getElementById('imageViewer').classList.add('hidden');

    if (data.isBinary) {
        useCodeMirror = false;
        destroyCodeMirror();
        document.getElementById('fileContentWrapper').classList.add('hidden');
        document.getElementById('binaryFileMessage').classList.remove('hidden');
        document.getElementById('editFileBtn').classList.add('hidden');
        document.getElementById('saveFileBtn').classList.add('hidden');
    } else {
        document.getElementById('fileContentWrapper').classList.remove('hidden');
        document.getElementById('binaryFileMessage').classList.add('hidden');
        document.getElementById('editFileBtn').classList.remove('hidden');
        document.getElementById('saveFileBtn').classList.add('hidden');

        // Decide whether to use CodeMirror
        useCodeMirror = shouldUseCodeMirror(data.name);

        if (useCodeMirror) {
            // Use CodeMirror
            document.getElementById('fileContent').classList.add('hidden');
            document.getElementById('codeMirrorEditor').classList.remove('hidden');
            initCodeMirror(data.content, true);

            // Highlight and scroll to lines if specified
            if (lineRange && codeMirrorEditor) {
                highlightLines(lineRange.start, lineRange.end);
                scrollToLine(lineRange.start);
            }
        } else {
            // Use textarea
            destroyCodeMirror();
            document.getElementById('codeMirrorEditor').classList.add('hidden');
            document.getElementById('fileContent').classList.remove('hidden');
            document.getElementById('fileContent').value = data.content;
        }
    }

    showFileView();
}

// Go back to parent folder
function goToParentFolder() {
    navigateTo(currentPath, true);
}

// Download current file
function downloadCurrentFile() {
    if (currentViewingFile) {
        downloadFile(currentViewingFile.path);
    }
}

// Enable edit mode
function enableEditMode() {
    editorBaseline = editorContent();
    editorLocation = window.location.pathname + (window.location.search || '') + (window.location.hash || '');
    document.getElementById('editFileBtn').classList.add('hidden');
    document.getElementById('saveFileBtn').classList.remove('hidden');

    if (useCodeMirror && codeMirrorEditor) {
        const container = document.getElementById('codeMirrorEditor');

        // Enable editing in CodeMirror
        codeMirrorEditor.setOption('readOnly', false);
        codeMirrorEditor.setOption('cursorBlinkRate', 530);
        codeMirrorEditor.getWrapperElement().classList.remove('cm-readonly');
        container.classList.add('edit-mode');
        codeMirrorEditor.refresh();
        codeMirrorEditor.focus();
    } else {
        // Textarea edit mode
        document.getElementById('fileContent').removeAttribute('readonly');
        document.getElementById('fileContent').classList.add('bg-gray-900', 'border', 'border-blue-500');
        document.getElementById('fileContent').focus();
    }
}

// Reset to view mode
function resetViewMode() {
    editorBaseline = null;
    document.getElementById('editFileBtn').classList.remove('hidden');
    document.getElementById('saveFileBtn').classList.add('hidden');

    if (useCodeMirror && codeMirrorEditor) {
        const container = document.getElementById('codeMirrorEditor');

        // Set to read-only in CodeMirror
        codeMirrorEditor.setOption('readOnly', true);
        codeMirrorEditor.setOption('cursorBlinkRate', -1);
        codeMirrorEditor.getWrapperElement().classList.add('cm-readonly');
        container.classList.remove('edit-mode');
        codeMirrorEditor.refresh();
    } else {
        // Textarea view mode
        document.getElementById('fileContent').setAttribute('readonly', true);
        document.getElementById('fileContent').classList.remove('bg-gray-900', 'border', 'border-blue-500');
    }
}

// Save current file
async function saveCurrentFile() {
    if (!currentViewingFile || currentViewingFile.isBinary) return;
    const savingFile = currentViewingFile;

    // Get content from CodeMirror or textarea
    let content;
    if (useCodeMirror && codeMirrorEditor) {
        content = codeMirrorEditor.getValue();
    } else {
        content = document.getElementById('fileContent').value;
    }

    try {
        await api('/api/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: savingFile.path,
                content: content
            })
        });
        if (currentViewingFile === savingFile) editorBaseline = content;
        showToast('File saved', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Load/refresh current directory (doesn't push history)
async function refreshFiles() {
    await navigateTo(currentPath, false);
}

// Render breadcrumbs
function renderBreadcrumbs(fileName = null) {
    const container = document.getElementById('breadcrumbs');
    const parts = currentPath ? currentPath.split('/') : [];

    let html = `<span class="breadcrumb cursor-pointer text-blue-400 hover:text-blue-300" onclick="navigateTo('')">Root</span>`;

    let pathSoFar = '';
    for (const part of parts) {
        pathSoFar += (pathSoFar ? '/' : '') + part;
        const p = pathSoFar;
        html += `<i data-lucide="chevron-right" class="w-4 h-4 text-gray-500"></i>`;
        html += `<span class="breadcrumb cursor-pointer text-blue-400 hover:text-blue-300" onclick="navigateTo(${inlineArg(p)})">${escapeHtml(part)}</span>`;
    }

    // Show file name in breadcrumbs if viewing a file
    if (fileName) {
        html += `<i data-lucide="chevron-right" class="w-4 h-4 text-gray-500"></i>`;
        html += `<span class="text-gray-100">${escapeHtml(fileName)}</span>`;
    }

    container.innerHTML = html;
    lucide.createIcons();
}

// Sort files and re-render - cycles through: ascending -> descending -> neutral
function sortFiles(column) {
    if (sortColumn === column) {
        // Same column clicked - cycle through: asc -> desc -> neutral
        if (sortAscending) {
            sortAscending = false; // Switch to descending
        } else {
            sortColumn = null; // Switch to neutral
        }
    } else {
        // Different column - start with ascending
        sortColumn = column;
        sortAscending = true;
    }
    renderFiles();
}

// Get sorted files array
function getSortedFiles() {
    // If neutral mode, return original order
    if (sortColumn === null) {
        return files;
    }

    const sorted = [...files];

    sorted.sort((a, b) => {
        let aVal, bVal;

        if (sortColumn === 'name') {
            aVal = a.name.toLowerCase();
            bVal = b.name.toLowerCase();
        } else if (sortColumn === 'size') {
            aVal = a.isDirectory ? -1 : a.size;
            bVal = b.isDirectory ? -1 : b.size;
        } else if (sortColumn === 'modified') {
            aVal = new Date(a.modified).getTime();
            bVal = new Date(b.modified).getTime();
        } else if (sortColumn === 'date_taken') {
            // Use exif_date if available, fallback to modified
            aVal = a.exif_date ? new Date(a.exif_date).getTime() : new Date(a.modified).getTime();
            bVal = b.exif_date ? new Date(b.exif_date).getTime() : new Date(b.modified).getTime();
        }

        if (aVal === bVal) return 0;

        if (sortAscending) {
            return aVal < bVal ? -1 : 1;
        } else {
            return aVal > bVal ? -1 : 1;
        }
    });

    return sorted;
}

// Update sort indicators
function updateSortIndicators() {
    document.getElementById('sortName').textContent = '';
    document.getElementById('sortSize').textContent = '';
    document.getElementById('sortModified').textContent = '';

    // Only show indicator if not in neutral mode
    if (sortColumn !== null) {
        if (sortColumn === 'name') {
            document.getElementById('sortName').textContent = sortAscending ? '▲' : '▼';
        } else if (sortColumn === 'size') {
            document.getElementById('sortSize').textContent = sortAscending ? '▲' : '▼';
        } else if (sortColumn === 'modified') {
            document.getElementById('sortModified').textContent = sortAscending ? '▲' : '▼';
        }
    }
}

// Render grid view (mobile)
function renderGridView() {
    const tbody = document.getElementById('fileList');
    
    // Photo Mode: filter non-images and sort by date_taken
    let sortedFiles = getSortedFiles();
    if (photoMode) {
        // Filter to only images and folders
        sortedFiles = sortedFiles.filter(f => f.isDirectory || isImage(f.name));
        
        // Default sort to date_taken_newest in Photo Mode
        if (sortColumn !== 'name' && sortColumn !== 'size' && sortColumn !== 'modified') {
            sortColumn = 'date_taken';
            sortAscending = false; // Newest first
        }
        sortedFiles = getSortedFiles().filter(f => f.isDirectory || isImage(f.name));
        
        // Render grid with group headers
        renderGridViewWithGroups(sortedFiles);
        return;
    }

    const previewScale = localStorage.getItem('filer-previewScale') || 'off';
    const sizes = PREVIEW_SIZES[previewScale] || { thumb: 40, icon: 28 };

    // Get current folder images for swipe navigation
    currentFolderImages = sortedFiles.filter(f => !f.isDirectory && isImage(f.name)).map(f => f.path);

    tbody.innerHTML = `
        <tr>
            <td colspan="5" class="p-0">
                <div class="file-grid">
                    ${sortedFiles.map((file, index) => {
                        const icon = file.isDirectory ? 'folder' : getFileIcon(file.name);
                        const iconColor = file.isDirectory ? 'text-yellow-500' : 'text-gray-400';
                        const selected = selectedFiles.has(file.path) ? 'selected' : '';

                        return `
                            <div class="file-grid-cell ${selected}" data-path="${escapeHtml(file.path)}"
                                 onclick="handleGridClick(${inlineArg(file.path)}, ${file.isDirectory}, ${index})"
                                 oncontextmenu="handleRightClick(event, ${inlineArg(file.path)})">
                                ${renderGridSelection(file)}
                                ${!file.isDirectory && isImage(file.name) ? `
                                    <div class="file-grid-thumb" data-image-index="${index}">
                                        <img src="/api/thumb?path=${encodeURIComponent(file.path)}&size=70" 
                                             loading="lazy" alt="" onerror="this.parentElement.innerHTML='<i class=\\'${iconColor}\\' data-lucide=\\'${icon}\\'></i>'">
                                    </div>
                                ` : `
                                    <div class="file-grid-thumb">
                                        <i data-lucide="${icon}" class="${iconColor} w-6 h-6"></i>
                                    </div>
                                `}
                                <span class="file-grid-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            </td>
        </tr>
    `;

    lucide.createIcons();
}

// Render grid view with month/year group headers (Photo Mode)
function renderGridViewWithGroups(sortedFiles) {
    const tbody = document.getElementById('fileList');
    
    // Get current folder images for swipe navigation
    currentFolderImages = sortedFiles.filter(f => !f.isDirectory && isImage(f.name)).map(f => f.path);

    // Group files by month/year
    const groups = {};
    sortedFiles.forEach(file => {
        let groupKey;
        
        if (file.isDirectory) {
            groupKey = '__folders__';
        } else {
            const date = file.exif_date ? new Date(file.exif_date) : new Date(file.modified);
            groupKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        }
        
        if (!groups[groupKey]) {
            groups[groupKey] = [];
        }
        groups[groupKey].push(file);
    });

    // Build HTML with group headers
    let html = '<tr><td colspan="5" class="p-0">';
    
    // First add folders (if any)
    if (groups['__folders__']) {
        html += renderGridGroup(groups['__folders__'], null);
        delete groups['__folders__'];
    }
    
    // Then add month groups in order (newest first)
    const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
    
    sortedKeys.forEach(groupKey => {
        const [year, month] = groupKey.split('-');
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];
        const headerText = `${monthNames[parseInt(month) - 1]} ${year}`;
        
        html += `<div class="gallery-group-header-grid">${headerText}</div>`;
        html += renderGridGroup(groups[groupKey], sortedFiles);
    });

    html += '</td></tr>';
    tbody.innerHTML = html;
    lucide.createIcons();
}

// Render a group of files in grid format
function renderGridGroup(files, allFiles) {
    let html = '<div class="file-grid">';
    
    files.forEach((file, index) => {
        const icon = file.isDirectory ? 'folder' : getFileIcon(file.name);
        const iconColor = file.isDirectory ? 'text-yellow-500' : 'text-gray-400';
        const selected = selectedFiles.has(file.path) ? 'selected' : '';
        
        // Find the actual index in the full sorted list for swipe navigation
        const actualIndex = allFiles ? allFiles.indexOf(file) : index;
        
        html += `
            <div class="file-grid-cell ${selected}" data-path="${escapeHtml(file.path)}"
                 onclick="handleGridClick(${inlineArg(file.path)}, ${file.isDirectory}, ${actualIndex})"
                 oncontextmenu="handleRightClick(event, ${inlineArg(file.path)})">
                ${renderGridSelection(file)}
                ${!file.isDirectory && isImage(file.name) ? `
                    <div class="file-grid-thumb" data-image-index="${actualIndex}">
                        <img src="/api/thumb?path=${encodeURIComponent(file.path)}&size=70" 
                             loading="lazy" alt="" onerror="this.parentElement.innerHTML='<i class=\\'${iconColor}\\' data-lucide=\\'${icon}\\'></i>'">
                    </div>
                ` : `
                    <div class="file-grid-thumb">
                        <i data-lucide="${icon}" class="${iconColor} w-6 h-6"></i>
                    </div>
                `}
                <span class="file-grid-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            </div>
        `;
    });
    
    html += '</div>';
    return html;
}

function renderGridSelection(file) {
    const selected = selectedFiles.has(file.path);
    return `<button class="grid-select" aria-label="Select ${escapeHtml(file.name)}" aria-pressed="${selected}"
                    onclick="event.stopPropagation(); toggleSelect(${inlineArg(file.path)})">
                <span class="grid-select-dot" aria-hidden="true">${selected ? '&#10003;' : ''}</span>
            </button>`;
}

function handleRightClick(event, path) {
    event.preventDefault();
    toggleSelect(path);
}

// Handle grid cell click
function handleGridClick(path, isDirectory, index) {
    if (selectedFiles.size > 0) {
        toggleSelect(path);
        return;
    }

    if (isDirectory) {
        navigateTo(path);
    } else if (isImage(path)) {
        openImageViewer(currentFolderImages.indexOf(path));
    } else {
        viewFile(path);
    }
}

// Render file list (or grid on mobile)
function renderFiles() {
    const tbody = document.getElementById('fileList');
    const emptyState = document.getElementById('emptyState');
    document.getElementById('fileListView').classList.toggle('mobile-grid-active', isMobile() && mobileViewMode === 'grid');
    document.getElementById('fileListView').classList.toggle('photo-mode-active', isMobile() && photoMode);

    updateSortIndicators();

    if (files.length === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    // Check if mobile and grid view
    if (isMobile() && mobileViewMode === 'grid') {
        renderGridView();
        return;
    }

    // Photo Mode: filter non-images and sort by date_taken
    let sortedFiles = getSortedFiles();
    if (photoMode && isMobile()) {
        // Filter to only images and folders (folders at top)
        sortedFiles = sortedFiles.filter(f => f.isDirectory || isImage(f.name));
        
        // Default sort to date_taken_newest in Photo Mode (if not already sorted)
        if (sortColumn !== 'name' && sortColumn !== 'size' && sortColumn !== 'modified') {
            sortColumn = 'date_taken';
            sortAscending = false; // Newest first
        }
        sortedFiles = getSortedFiles().filter(f => f.isDirectory || isImage(f.name));
        
        // Render with grouping
        renderFilesWithGroups(sortedFiles);
        return;
    }

    const previewScale = localStorage.getItem('filer-previewScale') || 'off';
    const sizes = PREVIEW_SIZES[previewScale];

    tbody.innerHTML = sortedFiles.map(file => {
        const icon = file.isDirectory ? 'folder' : getFileIcon(file.name);
        const iconColor = file.isDirectory ? 'text-yellow-500' : 'text-gray-400';
        const size = file.isDirectory ? '-' : formatSize(file.size);
        const modified = formatDate(file.modified);
        const selected = selectedFiles.has(file.path) ? 'selected' : '';

        let iconHtml;
        if (previewScale === 'off' || !sizes) {
            iconHtml = `<i data-lucide="${icon}" class="w-5 h-5 ${iconColor}"></i>`;
        } else if (!file.isDirectory && isImage(file.name)) {
            iconHtml = `<img src="/api/thumb?path=${encodeURIComponent(file.path)}&size=${sizes.thumb}" loading="lazy" style="width:${sizes.thumb}px;height:${sizes.thumb}px;" class="object-cover rounded flex-shrink-0">`;
        } else if (!file.isDirectory && isPdf(file.name)) {
            const scale = sizes.thumb / 400;
            iconHtml = `<div class="pdf-thumb" style="width:${sizes.thumb}px;height:${sizes.thumb}px;"><iframe src="/api/view?path=${encodeURIComponent(file.path)}#toolbar=0&navpanes=0&scrollbar=0" loading="lazy" style="transform:scale(${scale});"></iframe></div>`;
        } else {
            iconHtml = `<i data-lucide="${icon}" class="${iconColor}" style="width:${sizes.icon}px;height:${sizes.icon}px;"></i>`;
        }

        return `
            <tr class="file-row border-b border-gray-700 ${selected}" data-path="${escapeHtml(file.path)}">
                <td class="p-3">
                    <input type="checkbox" class="file-checkbox rounded bg-gray-700 border-gray-600" data-path="${escapeHtml(file.path)}"
                           ${selected ? 'checked' : ''} onchange="toggleSelect(${inlineArg(file.path)})">
                </td>
                <td class="p-3">
                    <div class="flex items-center gap-2 cursor-pointer" onclick="handleClick(${inlineArg(file.path)}, ${file.isDirectory})">
                        ${iconHtml}
                        <span class="text-gray-100 hover:text-blue-400">${escapeHtml(file.name)}</span>
                    </div>
                </td>
                <td class="p-3 text-sm text-gray-400">${size}</td>
                <td class="p-3 text-sm text-gray-400">${modified}</td>
                <td class="p-3">
                    <div class="flex gap-1 justify-end">
                        ${!file.isDirectory ? `
                            <button onclick="event.stopPropagation(); downloadFile(${inlineArg(file.path)})" class="p-1.5 hover:bg-gray-700 rounded" title="Download">
                                <i data-lucide="download" class="w-4 h-4 text-gray-400"></i>
                            </button>
                        ` : `
                            <span class="p-1.5 w-8"></span>
                        `}
                        <button onclick="event.stopPropagation(); showRenameModal(${inlineArg(file.path)}, ${inlineArg(file.name)})" class="p-1.5 hover:bg-gray-700 rounded" title="Rename">
                            <i data-lucide="pen-line" class="w-4 h-4 text-gray-400"></i>
                        </button>
                        <button onclick="event.stopPropagation(); deleteSingle(${inlineArg(file.path)})" class="p-1.5 hover:bg-gray-700 rounded" title="Delete">
                            <i data-lucide="trash-2" class="w-4 h-4 text-red-400"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    lucide.createIcons();
}

// Render files with month/year group headers (Photo Mode)
function renderFilesWithGroups(sortedFiles) {
    const tbody = document.getElementById('fileList');
    const previewScale = localStorage.getItem('filer-previewScale') || 'off';
    const sizes = PREVIEW_SIZES[previewScale];

    // Group files by month/year
    const groups = {};
    let currentGroup = null;
    
    sortedFiles.forEach(file => {
        let groupKey;
        
        if (file.isDirectory) {
            groupKey = '__folders__'; // Folders at top
        } else {
            // Get date for grouping
            const date = file.exif_date ? new Date(file.exif_date) : new Date(file.modified);
            groupKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; // e.g., "2026-02"
        }
        
        if (!groups[groupKey]) {
            groups[groupKey] = [];
        }
        groups[groupKey].push(file);
    });

    // Build HTML with group headers
    let html = '';
    
    // First add folders (if any)
    if (groups['__folders__']) {
        groups['__folders__'].forEach(file => {
            html += renderFileRow(file, sizes);
        });
        delete groups['__folders__'];
    }
    
    // Then add month groups in order
    const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a)); // Newest first
    
    sortedKeys.forEach(groupKey => {
        const [year, month] = groupKey.split('-');
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];
        const headerText = `${monthNames[parseInt(month) - 1]} ${year}`;
        
        html += `<tr class="gallery-group-header"><td colspan="5" class="px-3 py-2 text-sm font-semibold text-gray-300 bg-gray-800">${headerText}</td></tr>`;
        
        groups[groupKey].forEach(file => {
            html += renderFileRow(file, sizes);
        });
    });

    tbody.innerHTML = html;
    lucide.createIcons();
}

// Render a single file row (extracted for reuse in grouped view)
function renderFileRow(file, sizes) {
    const icon = file.isDirectory ? 'folder' : getFileIcon(file.name);
    const iconColor = file.isDirectory ? 'text-yellow-500' : 'text-gray-400';
    const size = file.isDirectory ? '-' : formatSize(file.size);
    const modified = formatDate(file.modified);
    const selected = selectedFiles.has(file.path) ? 'selected' : '';
    const previewScale = localStorage.getItem('filer-previewScale') || 'off';

    let iconHtml;
    if (previewScale === 'off' || !sizes) {
        iconHtml = `<i data-lucide="${icon}" class="w-5 h-5 ${iconColor}"></i>`;
    } else if (!file.isDirectory && isImage(file.name)) {
        iconHtml = `<img src="/api/thumb?path=${encodeURIComponent(file.path)}&size=${sizes.thumb}" loading="lazy" style="width:${sizes.thumb}px;height:${sizes.thumb}px;" class="object-cover rounded flex-shrink-0">`;
    } else if (!file.isDirectory && isPdf(file.name)) {
        const scale = sizes.thumb / 400;
        iconHtml = `<div class="pdf-thumb" style="width:${sizes.thumb}px;height:${sizes.thumb}px;"><iframe src="/api/view?path=${encodeURIComponent(file.path)}#toolbar=0&navpanes=0&scrollbar=0" loading="lazy" style="transform:scale(${scale});"></iframe></div>`;
    } else {
        iconHtml = `<i data-lucide="${icon}" class="${iconColor}" style="width:${sizes.icon}px;height:${sizes.icon}px;"></i>`;
    }

    return `
        <tr class="file-row border-b border-gray-700 ${selected}" data-path="${escapeHtml(file.path)}">
            <td class="p-3">
                <input type="checkbox" class="file-checkbox rounded bg-gray-700 border-gray-600" data-path="${escapeHtml(file.path)}"
                       ${selected ? 'checked' : ''} onchange="toggleSelect(${inlineArg(file.path)})">
            </td>
            <td class="p-3">
                <div class="flex items-center gap-2 cursor-pointer" onclick="handleClick(${inlineArg(file.path)}, ${file.isDirectory})">
                    ${iconHtml}
                    <span class="text-gray-100 hover:text-blue-400">${escapeHtml(file.name)}</span>
                </div>
            </td>
            <td class="p-3 text-sm text-gray-400">${size}</td>
            <td class="p-3 text-sm text-gray-400">${modified}</td>
            <td class="p-3">
                <div class="flex gap-1 justify-end">
                    ${!file.isDirectory ? `
                        <button onclick="event.stopPropagation(); downloadFile(${inlineArg(file.path)})" class="p-1.5 hover:bg-gray-700 rounded" title="Download">
                            <i data-lucide="download" class="w-4 h-4 text-gray-400"></i>
                        </button>
                    ` : `
                        <span class="p-1.5 w-8"></span>
                    `}
                    <button onclick="event.stopPropagation(); showRenameModal(${inlineArg(file.path)}, ${inlineArg(file.name)})" class="p-1.5 hover:bg-gray-700 rounded" title="Rename">
                        <i data-lucide="pen-line" class="w-4 h-4 text-gray-400"></i>
                    </button>
                    <button onclick="event.stopPropagation(); deleteSingle(${inlineArg(file.path)})" class="p-1.5 hover:bg-gray-700 rounded" title="Delete">
                        <i data-lucide="trash-2" class="w-4 h-4 text-red-400"></i>
                    </button>
                </div>
            </td>
        </tr>
    `;
}

// Get file icon based on extension
function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = {
        'js': 'file-code', 'ts': 'file-code', 'py': 'file-code', 'java': 'file-code',
        'html': 'file-code', 'css': 'file-code', 'json': 'file-json',
        'md': 'file-text', 'txt': 'file-text', 'log': 'file-text',
        'jpg': 'image', 'jpeg': 'image', 'png': 'image', 'gif': 'image', 'svg': 'image',
        'pdf': 'file-type', 'doc': 'file-text', 'docx': 'file-text',
        'zip': 'file-archive', 'tar': 'file-archive', 'gz': 'file-archive',
    };
    return icons[ext] || 'file';
}

// Format file size
function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return '-';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Format date
function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Handle click on file/folder
function handleClick(path, isDirectory) {
    if (isDirectory) {
        navigateTo(path);
    } else {
        navigateTo(path);
    }
}

// Selection
function toggleSelect(path) {
    if (selectedFiles.has(path)) {
        selectedFiles.delete(path);
    } else {
        selectedFiles.add(path);
    }
    renderFiles();
    updateToolbar();
}

function getVisibleFiles() {
    return isMobile() && photoMode ? files.filter(f => f.isDirectory || isImage(f.name)) : files;
}

function selectAllFiles() {
    selectedFiles.clear();
    getVisibleFiles().forEach(file => selectedFiles.add(file.path));
    renderFiles();
    updateToolbar();
}

function clearSelection() {
    selectedFiles.clear();
    renderFiles();
    updateToolbar();
}

function toggleSelectAll() {
    const selectAll = document.getElementById('selectAll');
    if (selectAll.checked) {
        getVisibleFiles().forEach(f => selectedFiles.add(f.path));
    } else {
        selectedFiles.clear();
    }
    renderFiles();
    updateToolbar();
}

function updateToolbar() {
    const hasSelection = selectedFiles.size > 0;
    document.getElementById('copyBtn').classList.toggle('hidden', !hasSelection);
    document.getElementById('pasteBtn').classList.toggle('hidden', !fileClipboard || fileClipboard.paths.length === 0);
    const deleteBtn = document.getElementById('deleteBtn');
    const moveBtn = document.getElementById('moveBtn');
    const zipBtn = document.getElementById('zipBtn');
    const newFileBtn = document.getElementById('newFileBtn');
    const newFolderBtn = document.getElementById('newFolderBtn');
    const uploadBtn = document.getElementById('uploadBtn');
    // Show/hide action buttons based on selection
    deleteBtn.classList.toggle('hidden', !hasSelection);
    deleteBtn.classList.toggle('flex', hasSelection);
    moveBtn.classList.toggle('hidden', !hasSelection);
    moveBtn.classList.toggle('flex', hasSelection);
    zipBtn.classList.toggle('hidden', !hasSelection);
    zipBtn.classList.toggle('flex', hasSelection);
    // Hide/show creation buttons (inverse of selection buttons)
    newFileBtn.classList.toggle('hidden', hasSelection);
    newFileBtn.classList.toggle('flex', !hasSelection);
    newFolderBtn.classList.toggle('hidden', hasSelection);
    newFolderBtn.classList.toggle('flex', !hasSelection);
    uploadBtn.classList.toggle('hidden', hasSelection);
    uploadBtn.classList.toggle('flex', !hasSelection);
    const visibleFiles = getVisibleFiles();
    document.getElementById('selectAll').checked = visibleFiles.length > 0 && visibleFiles.every(file => selectedFiles.has(file.path));
    document.getElementById('mobileSelectionBar').classList.toggle('hidden', !hasSelection);
    document.getElementById('mobileSelectionCount').textContent = `${selectedFiles.size} selected`;
    // Refresh icons when buttons change visibility
    lucide.createIcons();
}

// More menu toggle
function toggleMoreMenu() {
    const menu = document.getElementById('moreMenu');
    menu.classList.toggle('hidden');
    if (!menu.classList.contains('hidden')) {
        lucide.createIcons();
    }
}

function closeMoreMenu() {
    document.getElementById('moreMenu').classList.add('hidden');
}

// Mobile menu toggle
function toggleMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    menu.classList.toggle('open');
    if (menu.classList.contains('open')) {
        lucide.createIcons();
    }
}

// Close mobile menu when clicking backdrop
document.addEventListener('click', (e) => {
    const mobileMenu = document.getElementById('mobileMenu');
    const mobileBtn = document.getElementById('mobileActionsBtn');
    if (mobileMenu && mobileMenu.classList.contains('open') && 
        !mobileMenu.contains(e.target) && 
        !mobileBtn.contains(e.target)) {
        mobileMenu.classList.remove('open');
    }
});

// Close more menu when clicking outside
document.addEventListener('click', (e) => {
    const moreBtn = document.getElementById('moreMenuBtn');
    const moreMenu = document.getElementById('moreMenu');
    if (moreBtn && moreMenu && !moreBtn.contains(e.target) && !moreMenu.contains(e.target)) {
        moreMenu.classList.add('hidden');
    }
});

// ============== Download Progress ==============

let activeDownloader = null;

// Format bytes for display: "1.5 GB", "320 MB", etc.
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Format speed: "12.3 MB/s"
function formatSpeed(bytesPerSec) {
    return formatBytes(bytesPerSec) + '/s';
}

function showDownloadProgress(fileName) {
    const box = document.getElementById('downloadProgressBox');
    const nameEl = document.getElementById('downloadFileName');
    nameEl.textContent = fileName;
    nameEl.title = fileName;
    document.getElementById('downloadProgressBar').style.width = '0%';
    document.getElementById('downloadProgressPercent').textContent = '0%';
    document.getElementById('downloadProgressSize').textContent = '0 B / 0 B';
    document.getElementById('downloadSpeed').textContent = '0 B/s';
    box.classList.remove('hidden');
    lucide.createIcons();
}

function hideDownloadProgress() {
    document.getElementById('downloadProgressBox').classList.add('hidden');
}

function updateDownloadProgress(percent, speed, downloaded, total) {
    document.getElementById('downloadProgressBar').style.width = percent + '%';
    document.getElementById('downloadProgressPercent').textContent = Math.round(percent) + '%';
    document.getElementById('downloadProgressSize').textContent = formatBytes(downloaded) + ' / ' + (total ? formatBytes(total) : '?');
    document.getElementById('downloadSpeed').textContent = formatSpeed(speed);
}

function cancelActiveDownload() {
    if (activeDownloader) {
        activeDownloader.cancel();
    }
}

class StreamDownloader {
    constructor(path) {
        this.path = path;
        this.fileName = path.split('/').pop();
        this.abortController = new AbortController();
        this.cancelled = false;
        this.fileHandle = null;
        this.writable = null;
    }

    async start() {
        // Prevent concurrent downloads
        if (activeDownloader) {
            showToast('A download is already in progress', 'error');
            return;
        }
        activeDownloader = this;
        showDownloadProgress(this.fileName);

        const url = `/api/download?path=${encodeURIComponent(this.path)}`;

        try {
            // Try File System Access API first (Chromium browsers)
            if (window.showSaveFilePicker) {
                await this._downloadWithFileSystemAPI(url);
            } else {
                this._downloadNatively(url);
            }
        } catch (err) {
            if (this.cancelled || err.name === 'AbortError') {
                showToast('Download cancelled', 'info');
            } else {
                showToast('Download failed: ' + err.message, 'error');
            }
        } finally {
            await this._cleanup();
        }
    }

    async _downloadWithFileSystemAPI(url) {
        // Prompt user for save location first
        try {
            this.fileHandle = await window.showSaveFilePicker({
                suggestedName: this.fileName
            });
        } catch (err) {
            // User cancelled the save picker — don't treat as error
            this.cancelled = true;
            return;
        }

        const response = await fetch(url, { signal: this.abortController.signal });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);

        const totalSize = parseInt(response.headers.get('Content-Length'), 10) || 0;
        let downloaded = 0;
        let lastTime = performance.now();
        let lastBytes = 0;
        let speed = 0;

        this.writable = await this.fileHandle.createWritable();

        const reader = response.body.getReader();
        this.reader = reader;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            await this.writable.write(value);
            downloaded += value.byteLength;

            // Calculate speed every 200ms
            const now = performance.now();
            const elapsed = (now - lastTime) / 1000;
            if (elapsed >= 0.2) {
                speed = (downloaded - lastBytes) / elapsed;
                lastBytes = downloaded;
                lastTime = now;
            }

            const percent = totalSize ? (downloaded / totalSize) * 100 : 0;
            updateDownloadProgress(percent, speed, downloaded, totalSize);
        }

        if (totalSize && downloaded !== totalSize) throw new Error("Download was interrupted");
        await this.writable.close();
        this.writable = null;

        hideDownloadProgress();
        showToast('Download complete', 'success');
    }

    _downloadNatively(url) {
        // Let the browser stream to disk instead of collecting a multi-GB Blob in RAM.
        const link = document.createElement('a');
        link.href = url;
        link.download = this.fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        showToast('Download started in your browser; use its downloads panel for progress or cancellation', 'info');
    }

    cancel() {
        this.cancelled = true;
        this.abortController.abort();
        this._cleanupWritable();
    }

    async _cleanupWritable() {
        if (this.writable) {
            const writable = this.writable;
            this.writable = null;
            try { await writable.abort(); } catch (e) { /* ignore */ }
        }
    }

    async _cleanup() {
        await this._cleanupWritable();
        if (this.reader) {
            try { await this.reader.cancel(); } catch (e) { /* already closed */ }
            this.reader.releaseLock();
            this.reader = null;
        }
        hideDownloadProgress();
        activeDownloader = null;
        this.writable = null;
        this.fileHandle = null;
    }
}

// Download selected files/folders as zip
function downloadSelectedAsZip() {
    if (selectedFiles.size === 0) return;
    const params = new URLSearchParams();
    selectedFiles.forEach(p => params.append('paths', p));
    window.location.href = '/api/zip?' + params.toString();
}

// File operations
function downloadFile(path) {
    const downloader = new StreamDownloader(path);
    downloader.start();
}

// New file/folder
function showNewFileModal() {
    newItemIsFolder = false;
    document.getElementById('newItemTitle').textContent = 'New File';
    document.getElementById('newItemName').value = '';
    document.getElementById('newItemName').placeholder = 'filename.txt';
    document.getElementById('newItemModal').classList.remove('hidden');
    document.getElementById('newItemName').focus();
}

function showNewFolderModal() {
    newItemIsFolder = true;
    document.getElementById('newItemTitle').textContent = 'New Folder';
    document.getElementById('newItemName').value = '';
    document.getElementById('newItemName').placeholder = 'folder name';
    document.getElementById('newItemModal').classList.remove('hidden');
    document.getElementById('newItemName').focus();
}

function closeNewItemModal() {
    document.getElementById('newItemModal').classList.add('hidden');
}

async function createNewItem() {
    const name = document.getElementById('newItemName').value.trim();
    if (!name) {
        showToast('Please enter a name', 'error');
        return;
    }

    try {
        await api('/api/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                parent: currentPath,
                name: name,
                isFolder: newItemIsFolder
            })
        });
        closeNewItemModal();
        showToast(`${newItemIsFolder ? 'Folder' : 'File'} created`, 'success');
        refreshFiles();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ============== Upload Progress ==============

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB - must match server config
const PARALLEL_CHUNKS = 3;
let activeUploader = null;

function showUploadProgress(fileName) {
    const box = document.getElementById('uploadProgressBox');
    const nameEl = document.getElementById('uploadFileName');
    nameEl.textContent = fileName;
    nameEl.title = fileName;
    document.getElementById('uploadProgressBar').style.width = '0%';
    document.getElementById('uploadProgressPercent').textContent = '0%';
    document.getElementById('uploadProgressSize').textContent = '0 B / 0 B';
    document.getElementById('uploadSpeed').textContent = '0 B/s';
    box.classList.remove('hidden');
    lucide.createIcons();
}

function hideUploadProgress() {
    document.getElementById('uploadProgressBox').classList.add('hidden');
}

function updateUploadProgress(percent, speed, uploaded, total) {
    document.getElementById('uploadProgressBar').style.width = percent + '%';
    document.getElementById('uploadProgressPercent').textContent = Math.round(percent) + '%';
    document.getElementById('uploadProgressSize').textContent = formatBytes(uploaded) + ' / ' + (total ? formatBytes(total) : '?');
    document.getElementById('uploadSpeed').textContent = formatSpeed(speed);
}

function cancelActiveUpload() {
    if (activeUploader) {
        activeUploader.cancel();
    }
}

class ChunkedUploader {
    constructor(files, destPath) {
        this.files = files;
        this.destPath = destPath;
        this.cancelled = false;
        this.failed = false;
        this.activeXHRs = new Set();
        this.currentUploadId = null;
        this.resumeKey = null;
        this.totalBytes = files.reduce((sum, entry) => sum + entry.file.size, 0);
        this.uploadedBytes = 0;
        this.chunkProgress = new Map();
        this.lastTime = performance.now();
        this.lastBytes = 0;
        this.speed = 0;
    }

    async start() {
        if (activeUploader) {
            showToast('An upload is already in progress', 'error');
            return;
        }
        activeUploader = this;
        showUploadProgress(this.files.length === 1 ? this.files[0].file.name : `${this.files.length} files`);
        let completed = 0;
        const errors = [];
        try {
            for (const { file, destPath } of this.files) {
                if (this.cancelled) break;
                this.failed = false;
                this.currentUploadId = null;
                this.resumeKey = null;
                this.chunkProgress = new Map();
                document.getElementById('uploadFileName').textContent = file.name;
                document.getElementById('uploadFileName').title = file.name;
                try {
                    if (file.size < CHUNK_SIZE) await this._uploadSmall(file, destPath);
                    else await this._uploadChunked(file, destPath);
                    if (!this.cancelled) {
                        completed++;
                        this.uploadedBytes += file.size;
                    }
                } catch (error) {
                    if (!this.cancelled) {
                        const resume = this.currentUploadId ? ' Select this file again to resume.' : '';
                        errors.push({ error: `${file.name}: ${error.message}.${resume}` });
                    }
                }
            }
            if (completed > 0) await refreshFiles();
            if (!this.cancelled) reportOperationResult('Uploaded', completed, errors);
        } finally {
            if (this.cancelled) await this._cancelSession();
            for (const xhr of this.activeXHRs) xhr.abort();
            this.activeXHRs.clear();
            hideUploadProgress();
            activeUploader = null;
            this.currentUploadId = null;
        }
    }

    _updateProgress() {
        const total = this.uploadedBytes + [...this.chunkProgress.values()].reduce((a, b) => a + b, 0);
        const now = performance.now();
        const elapsed = (now - this.lastTime) / 1000;
        if (elapsed >= 0.2) {
            this.speed = Math.max(0, (total - this.lastBytes) / elapsed);
            this.lastBytes = total;
            this.lastTime = now;
        }
        updateUploadProgress(this.totalBytes ? total / this.totalBytes * 100 : 0, this.speed, total, this.totalBytes);
    }

    async _json(url, data) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data), signal: controller.signal
            });
            let body;
            try { body = await response.json(); }
            catch (error) { throw new Error(`Invalid server response (${response.status})`); }
            if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { status: response.status });
            return body;
        } finally {
            clearTimeout(timer);
        }
    }

    _remember(id) {
        if (!this.resumeKey) return;
        try {
            if (id) localStorage.setItem(this.resumeKey, id);
            else localStorage.removeItem(this.resumeKey);
        } catch (error) { /* Uploading still works if browser storage is unavailable. */ }
    }

    _xhr(url, form, key, size, validate) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            this.activeXHRs.add(xhr);
            xhr.timeout = 120000;
            const fail = (message, retryable = false) => {
                this.activeXHRs.delete(xhr);
                reject(Object.assign(new Error(message), { retryable }));
            };
            xhr.upload.addEventListener('progress', event => {
                if (event.lengthComputable) {
                    this.chunkProgress.set(key, Math.min(event.loaded, size));
                    this._updateProgress();
                }
            });
            xhr.addEventListener('load', () => {
                this.activeXHRs.delete(xhr);
                let body;
                try { body = JSON.parse(xhr.responseText); }
                catch (error) { fail(`Invalid server response (${xhr.status})`, xhr.status >= 500); return; }
                if (xhr.status < 200 || xhr.status >= 300) {
                    fail(body.error || `Upload failed (${xhr.status})`, [408, 429, 500, 502, 503, 504].includes(xhr.status));
                    return;
                }
                try { validate(body); }
                catch (error) { reject(error); return; }
                this.chunkProgress.set(key, size);
                this._updateProgress();
                resolve(body);
            });
            xhr.addEventListener('error', () => fail('Network error', true));
            xhr.addEventListener('timeout', () => fail('Upload timed out', true));
            xhr.addEventListener('abort', () => fail('Upload cancelled'));
            xhr.open('POST', url);
            xhr.send(form);
        });
    }

    _uploadSmall(file, destPath) {
        const form = new FormData();
        form.append('path', destPath);
        form.append('files', file);
        return this._xhr('/api/upload', form, 'small', file.size, body => {
            if (body.errors?.length || body.uploaded?.length !== 1) {
                throw new Error(body.errors?.[0]?.error || 'The file was not uploaded');
            }
        });
    }

    async _uploadChunked(file, destPath) {
        this.resumeKey = 'filer-upload-v1:' + JSON.stringify([destPath, file.name, file.size, file.lastModified]);
        let id;
        try { id = localStorage.getItem(this.resumeKey); } catch (error) { /* no browser storage */ }
        let status;
        if (id) {
            this.currentUploadId = id;
            try {
                status = await this._json('/api/upload/status', { uploadId: id });
            } catch (error) {
                if (![404, 410].includes(error.status)) throw error;
                id = null;
                this.currentUploadId = null;
                this._remember(null);
            }
        }
        if (!id) {
            if (this.cancelled) return;
            const init = await this._json('/api/upload/init', { fileName: file.name, fileSize: file.size, destPath });
            if (typeof init.uploadId !== 'string' || !Number.isInteger(init.chunkSize) || init.chunkSize <= 0) {
                throw new Error('Invalid upload initialization response');
            }
            id = init.uploadId;
            status = { received: [], chunkSize: init.chunkSize };
            this.currentUploadId = id;
            this._remember(id);
        }
        if (this.cancelled) { await this._cancelSession(); return; }
        if (typeof status.completed === 'string' && status.completed) {
            this._remember(null);
            this.currentUploadId = null;
            return;
        }
        const chunkSize = status.chunkSize;
        if (!Number.isInteger(chunkSize) || chunkSize <= 0 || (status.fileSize !== undefined && status.fileSize !== file.size)) {
            throw new Error('Upload checkpoint does not match this file');
        }
        const received = new Set(status.received);
        const chunks = [];
        for (let index = 0; index < Math.ceil(file.size / chunkSize); index++) {
            const start = index * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            if (received.has(index)) this.chunkProgress.set(index, end - start);
            else chunks.push({ index, start, end });
        }
        this._updateProgress();
        let next = 0;
        const worker = async () => {
            while (!this.cancelled && !this.failed) {
                const chunk = chunks[next++];
                if (!chunk) return;
                try { await this._sendChunk(id, file, chunk); }
                catch (error) { this.failed = true; throw error; }
            }
        };
        // Await every worker before changing session state or moving to another file.
        const results = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL_CHUNKS, chunks.length) }, worker));
        if (this.cancelled) return;
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        const completed = await this._json('/api/upload/complete', { uploadId: id });
        if (!completed.success || typeof completed.path !== 'string') {
            throw new Error('The server did not confirm upload completion');
        }
        this._remember(null);
        this.currentUploadId = null;
    }

    async _sendChunk(id, file, chunk) {
        for (let attempt = 0; ; attempt++) {
            if (this.cancelled || this.failed) throw new Error('Upload cancelled');
            const form = new FormData();
            form.append('uploadId', id);
            form.append('chunkIndex', chunk.index);
            form.append('chunk', file.slice(chunk.start, chunk.end));
            try {
                return await this._xhr('/api/upload/chunk', form, chunk.index, chunk.end - chunk.start, body => {
                    if (!body.received) throw new Error('Chunk was not acknowledged');
                });
            } catch (error) {
                if (this.cancelled || !error.retryable || attempt >= 2) throw error;
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }
    }

    async _cancelSession() {
        const id = this.currentUploadId;
        if (!id) return true;
        try {
            const cancelled = await this._json('/api/upload/cancel', { uploadId: id });
            if (!cancelled.success) throw new Error('Cancellation was not acknowledged');
            if (this.currentUploadId === id) this.currentUploadId = null;
            this._remember(null);
            return true;
        } catch (error) {
            showToast('Could not finish cancelling the upload. Its checkpoint is retained for retry.', 'error');
            return false;
        }
    }

    async cancel() {
        this.cancelled = true;
        for (const xhr of this.activeXHRs) xhr.abort();
        this.activeXHRs.clear();
        if (await this._cancelSession()) showToast('Upload cancelled', 'info');
    }
}

// Upload
async function uploadFiles(fileList) {
    if (!fileList.length) return;

    const files = Array.from(fileList).map(file => ({
        file,
        destPath: currentPath
    }));

    const uploader = new ChunkedUploader(files, currentPath);
    await uploader.start();

    document.getElementById('uploadInput').value = '';
}

function reportOperationResult(verb, count, errors = []) {
    if (errors.length > 0) {
        showToast(`${verb} ${count} item(s); ${errors.length} failed: ${errors[0].error}`, 'error');
    } else {
        showToast(`${verb} ${count} item(s)`, count > 0 ? 'success' : 'info');
    }
}

async function refreshWithFailedSelection(paths) {
    await refreshFiles();
    selectedFiles = new Set(paths.filter(path => files.some(file => file.path === path)));
    renderFiles();
    updateToolbar();
}

// Delete
async function deleteSingle(path) {
    const fileName = path.split('/').pop();
    const confirmed = await showConfirmDialog({
        title: 'Delete File',
        message: `Are you sure you want to delete "${fileName}"? It will be moved to trash.`,
        confirmText: 'Delete'
    });
    if (!confirmed) return;
    await deleteFiles([path]);
}

async function deleteSelected() {
    if (selectedFiles.size === 0) return;
    const confirmed = await showConfirmDialog({
        title: 'Delete Items',
        message: `Are you sure you want to delete ${selectedFiles.size} item(s)? They will be moved to trash.`,
        confirmText: 'Delete'
    });
    if (!confirmed) return;
    await deleteFiles(Array.from(selectedFiles));
}

async function deleteFiles(paths) {
    try {
        const result = await api('/api/file', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths })
        });
        await refreshWithFailedSelection(result.errors.map(error => error.path));
        reportOperationResult('Deleted', result.deleted.length, result.errors);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Move
async function showMoveModal(clipboard = false) {
    if (transferBusy) return;
    const paths = clipboard && fileClipboard ? [...fileClipboard.paths] : Array.from(selectedFiles);
    if (paths.length === 0) return;
    pendingTransfer = { paths, action: clipboard ? fileClipboard.action : 'move' };
    const label = pendingTransfer.action === 'copy' ? 'Copy' : 'Move';
    document.getElementById('transferTitle').textContent = `${label} to...`;
    document.getElementById('transferSubmit').textContent = `${label} Here`;
    document.getElementById('transferConflict').value = clipboard ? 'keep_both' : 'skip';

    moveDestination = clipboard ? currentPath : '';
    document.getElementById('moveDestinationDisplay').textContent = moveDestination || 'Root';
    document.getElementById('moveModal').classList.remove('hidden');

    // Fetch folder tree, excluding selected items
    const excludeParams = paths.map(p => `exclude=${encodeURIComponent(p)}`).join('&');
    try {
        const data = await api(`/api/folders?${excludeParams}`);
        renderFolderTree(data.folders);
    } catch (err) {
        document.getElementById('folderTree').innerHTML = `<div class="text-red-400 text-sm">Error loading folders</div>`;
    }
}

function getAncestorPaths(path) {
    if (!path) return new Set();
    const parts = path.split('/');
    const ancestors = new Set();
    for (let i = 1; i <= parts.length; i++) {
        ancestors.add(parts.slice(0, i).join('/'));
    }
    return ancestors;
}

function toggleFolder(path, event) {
    event.stopPropagation();
    const cssId = CSS.escape(path);
    const childrenEl = document.getElementById(`folder-children-${path}`);
    const chevronEl = document.querySelector(`[data-folder-chevron="${cssId}"]`);
    if (expandedFolders.has(path)) {
        expandedFolders.delete(path);
        if (childrenEl) childrenEl.classList.add('hidden');
        if (chevronEl) chevronEl.setAttribute('data-lucide', 'chevron-right');
    } else {
        expandedFolders.add(path);
        if (childrenEl) childrenEl.classList.remove('hidden');
        if (chevronEl) chevronEl.setAttribute('data-lucide', 'chevron-down');
    }
    if (chevronEl) lucide.createIcons({ nodes: [chevronEl] });
}

function renderFolderTree(folders) {
    expandedFolders = getAncestorPaths(currentPath);
    const container = document.getElementById('folderTree');

    let html = `
        <div class="folder-item flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-gray-700 ${moveDestination === '' ? 'bg-gray-700' : ''}"
             onclick="selectMoveDestination('', 'Root', event)">
            <i data-lucide="hard-drive" class="w-5 h-5 text-blue-400"></i>
            <span class="text-gray-100 font-medium">Root</span>
        </div>
        <div class="ml-3 pl-3 border-l border-gray-700">
            ${renderFolderLevel(folders)}
        </div>
    `;

    container.innerHTML = html;
    lucide.createIcons();
}

function renderFolderLevel(folders) {
    let html = '';

    for (const folder of folders) {
        const hasChildren = folder.children && folder.children.length > 0;
        const isSelected = moveDestination === folder.path;
        const isExpanded = expandedFolders.has(folder.path);

        const chevron = hasChildren
            ? `<i data-lucide="${isExpanded ? 'chevron-down' : 'chevron-right'}" data-folder-chevron="${escapeHtml(folder.path)}" class="w-4 h-4 text-gray-400 shrink-0 cursor-pointer" onclick="toggleFolder(${inlineArg(folder.path)}, event)"></i>`
            : `<span class="w-4 h-4 shrink-0"></span>`;

        html += `
            <div class="folder-item flex items-center gap-1 p-2 rounded cursor-pointer hover:bg-gray-700 ${isSelected ? 'bg-gray-700' : ''}"
                 onclick="selectMoveDestination(${inlineArg(folder.path)}, ${inlineArg(folder.name)}, event)">
                ${chevron}
                <i data-lucide="folder" class="w-4 h-4 text-yellow-400 shrink-0"></i>
                <span class="text-gray-200 text-sm">${escapeHtml(folder.name)}</span>
            </div>
        `;

        if (hasChildren) {
            html += `<div id="folder-children-${escapeHtml(folder.path)}" class="ml-2 pl-2 border-l border-gray-700 ${isExpanded ? '' : 'hidden'}">${renderFolderLevel(folder.children)}</div>`;
        }
    }

    return html;
}

function selectMoveDestination(path, name, event) {
    moveDestination = path;
    document.getElementById('moveDestinationDisplay').textContent = path || 'Root';

    // Update visual selection
    document.querySelectorAll('#folderTree .folder-item').forEach(el => {
        el.classList.remove('bg-gray-700');
    });
    if (event) event.currentTarget.classList.add('bg-gray-700');
}

function closeMoveModal() {
    if (transferBusy) return;
    document.getElementById('moveModal').classList.add('hidden');
}

async function moveSelected() {
    if (transferBusy) return;
    const transfer = pendingTransfer || { paths: Array.from(selectedFiles), action: 'move' };
    const items = transfer.paths.map(source => {
        const name = source.split('/').pop();
        return {
            source,
            destination: moveDestination ? `${moveDestination}/${name}` : name
        };
    });

    const conflict = document.getElementById('transferConflict').value || 'skip';
    transferBusy = true;
    if (conflict === 'replace' && !await showConfirmDialog({ title: 'Replace existing items?', message: 'Existing files or entire folders with the same name will be moved to Trash before replacement. Folders are not merged.', confirmText: 'Replace' })) {
        transferBusy = false;
        return;
    }
    document.getElementById('transferSubmit').disabled = true;
    document.getElementById('transferSubmit').textContent = 'Working…';
    try {
        const result = await api('/api/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, action: transfer.action, conflict })
        });
        const completed = result.completed || result.moved || [];
        const skipped = result.skipped || [];
        const retained = [...result.errors.map(error => error.source), ...skipped.map(item => item.source)];
        pendingTransfer = { paths: retained, action: transfer.action };
        if (fileClipboard && transfer.action === 'move') {
            const done = new Set(completed.map(item => item.source));
            fileClipboard.paths = fileClipboard.paths.filter(path => !done.has(path));
        }
        transferBusy = false;
        if (result.errors.length === 0) closeMoveModal();
        await refreshWithFailedSelection(retained);
        const verb = transfer.action === 'copy' ? 'Copied' : 'Moved';
        if (result.errors.length) reportOperationResult(verb, completed.length, result.errors);
        else showToast(`${verb} ${completed.length} item(s)${skipped.length ? `; ${skipped.length} skipped (already exist)` : ''}`, skipped.length ? 'info' : 'success');
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        transferBusy = false;
        document.getElementById('transferSubmit').disabled = false;
        document.getElementById('transferSubmit').textContent = transfer.action === 'copy' ? 'Copy Here' : 'Move Here';
    }
}

function setFileClipboard(action) {
    if (!selectedFiles.size) return showToast('Select files or folders first', 'info');
    fileClipboard = { action, paths: Array.from(selectedFiles) };
    updateToolbar();
    showToast(`${fileClipboard.paths.length} item(s) ready to ${action === 'copy' ? 'copy' : 'move'}. Open the destination folder and choose Paste.`, 'info');
}

function pasteFiles() {
    if (!fileClipboard || !fileClipboard.paths.length) return showToast('Copy or cut some items first', 'info');
    return showMoveModal(true);
}

async function duplicateSelected() {
    if (transferBusy) return;
    if (!selectedFiles.size) return showToast('Select files or folders first', 'info');
    transferBusy = true;
    const paths = Array.from(selectedFiles);
    try {
        const result = await api('/api/transfer', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'copy', conflict: 'keep_both',
                items: paths.map(source => ({ source, destination: source })) })
        });
        await refreshWithFailedSelection(result.errors.map(error => error.source));
        reportOperationResult('Duplicated', result.completed.length, result.errors);
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        transferBusy = false;
    }
}

function browseSelectedArchive() {
    if (selectedFiles.size !== 1) return showToast('Select one ZIP file first', 'info');
    return browseArchive(Array.from(selectedFiles)[0]);
}

async function browseArchive(path) {
    if (archiveBusy) return;
    archiveBusy = true;
    archivePath = null;
    archiveEntries = [];
    document.getElementById('archiveModal').classList.remove('hidden');
    document.getElementById('archiveTitle').textContent = path.split('/').pop();
    document.getElementById('archiveEntries').textContent = 'Loading ZIP contents…';
    document.getElementById('archiveStatus').textContent = '';
    document.getElementById('extractSubmit').disabled = true;
    document.getElementById('archiveSelectAll').checked = true;
    document.getElementById('archiveDestination').value = path.replace(/\.zip$/i, '') + ' extracted';
    try {
        const result = await api(`/api/archive?path=${encodeURIComponent(path)}`);
        archivePath = path;
        archiveEntries = result.entries;
        document.getElementById('archiveEntries').innerHTML = archiveEntries.map((entry, index) =>
            `<label class="flex items-start gap-2 text-sm text-gray-200 py-1"><input class="archive-entry mt-1" type="checkbox" data-index="${index}" checked onchange="updateArchiveSelection()"><span class="break-all">${escapeHtml(entry.path)}${entry.isDirectory ? '' : ` (${escapeHtml(formatSize(entry.size))})`}</span></label>`
        ).join('') || '<p class="text-gray-400">Empty ZIP archive</p>';
        document.getElementById('archiveStatus').textContent = `${archiveEntries.length} entries. Extracts into a new folder; existing folders are preserved.`;
        document.getElementById('extractSubmit').disabled = archiveEntries.length === 0;
    } catch (err) {
        document.getElementById('archiveEntries').textContent = err.message;
        showToast(err.message, 'error');
    } finally {
        archiveBusy = false;
    }
}

function closeArchiveModal() {
    if (!archiveBusy) document.getElementById('archiveModal').classList.add('hidden');
}

function selectArchiveEntries(checked) {
    document.querySelectorAll('.archive-entry').forEach(input => { input.checked = checked; });
    updateArchiveSelection();
}

function updateArchiveSelection() {
    const inputs = Array.from(document.querySelectorAll('.archive-entry'));
    const selected = inputs.filter(input => input.checked).length;
    document.getElementById('archiveSelectAll').checked = inputs.length > 0 && selected === inputs.length;
    document.getElementById('archiveSelectAll').indeterminate = selected > 0 && selected < inputs.length;
}

async function extractArchive() {
    if (archiveBusy || !archivePath) return;
    const members = Array.from(document.querySelectorAll('.archive-entry'))
        .filter(input => input.checked).map(input => archiveEntries[Number(input.dataset.index)].path);
    if (!members.length) return showToast('Select at least one entry', 'info');
    const destination = document.getElementById('archiveDestination').value.trim();
    if (!destination) return showToast('Enter a new destination folder', 'info');
    archiveBusy = true;
    document.getElementById('extractSubmit').disabled = true;
    document.getElementById('archiveStatus').textContent = 'Extracting…';
    try {
        const result = await api('/api/archive/extract', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: archivePath, destination, members })
        });
        archiveBusy = false;
        closeArchiveModal();
        await refreshFiles();
        showToast(`Extracted ${result.extracted} file(s) into ${result.destination}`, 'success');
    } catch (err) {
        document.getElementById('archiveStatus').textContent = err.message;
        showToast(err.message, 'error');
    } finally {
        archiveBusy = false;
        document.getElementById('extractSubmit').disabled = false;
    }
}

document.addEventListener('keydown', event => {
    const target = event.target;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest?.('.CodeMirror'))) return;
    if (event.key === 'Escape') closeArchiveModal();
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || viewMode === 'file') return;
    const key = event.key.toLowerCase();
    if ((key === 'c' || key === 'x') && selectedFiles.size) {
        if (window.getSelection?.().toString()) return;
        event.preventDefault();
        setFileClipboard(key === 'c' ? 'copy' : 'move');
    } else if (key === 'v' && fileClipboard?.paths.length) {
        event.preventDefault();
        pasteFiles();
    }
});

// Rename
function showRenameModal(path, currentName) {
    renamingPath = path;
    document.getElementById('renameName').value = currentName;
    document.getElementById('renameModal').classList.remove('hidden');
    document.getElementById('renameName').focus();
    document.getElementById('renameName').select();
}

function closeRenameModal() {
    document.getElementById('renameModal').classList.add('hidden');
    renamingPath = null;
}

async function renameItem() {
    const newName = document.getElementById('renameName').value.trim();
    if (!newName) {
        showToast('Please enter a name', 'error');
        return;
    }

    try {
        await api('/api/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: renamingPath,
                newName: newName
            })
        });
        closeRenameModal();
        showToast('Renamed successfully', 'success');
        refreshFiles();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Search functionality
async function performSearch(pushHistory = true) {
    const query = document.getElementById('searchInput').value.trim();

    if (!query) {
        showToast('Enter a search term', 'error');
        return;
    }
    if (!await allowNavigation()) return;

    try {
        const params = new URLSearchParams({
            q: query,
            path: currentPath,
            content: 'true'
        });

        const data = await api(`/api/search?${params}`);

        // Update URL with search query
        if (pushHistory) {
            const newUrl = fileUrlPath(currentPath || '') + '?q=' + encodeURIComponent(query);
            pushNavigationState({ type: 'search', query, path: currentPath }, '', newUrl);
        }

        renderSearchResults(data);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Execute search from URL parameters
async function executeSearchFromUrl(query) {
    document.getElementById('searchInput').value = query;

    try {
        const params = new URLSearchParams({
            q: query,
            path: currentPath,
            content: 'true'
        });

        const data = await api(`/api/search?${params}`);
        renderSearchResults(data);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderSearchResults(data) {
    const container = document.getElementById('searchResultsList');
    const emptyState = document.getElementById('searchEmptyState');
    const truncatedMsg = document.getElementById('searchTruncatedMsg');

    document.getElementById('searchResultsTitle').textContent = `Search Results for "${data.query}" (${data.results.length})`;

    if (data.results.length === 0) {
        container.innerHTML = '';
        emptyState.classList.remove('hidden');
        truncatedMsg.classList.add('hidden');
    } else {
        emptyState.classList.add('hidden');
        truncatedMsg.classList.toggle('hidden', !data.truncated);

        container.innerHTML = data.results.map(item => {
            const icon = item.isDirectory ? 'folder' : getFileIcon(item.name);
            const iconColor = item.isDirectory ? 'text-yellow-500' : 'text-gray-400';

            let contentMatchesHtml = '';
            if (item.contentMatches && item.contentMatches.length > 0) {
                contentMatchesHtml = `
                    <div class="mt-2 space-y-1">
                        ${item.contentMatches.map(m => `
                            <div class="text-xs bg-gray-900 p-2 rounded font-mono text-gray-300 cursor-pointer hover:bg-gray-800" onclick="openSearchResultWithLine(${inlineArg(item.path)}, ${m.line}, event)">
                                <span class="text-blue-400 hover:text-blue-300">Line ${m.line}:</span> ${highlightText(m.text, data.query)}
                            </div>
                        `).join('')}
                    </div>
                `;
            }

            const displayName = item.nameMatch ? highlightText(item.name, data.query) : escapeHtml(item.name);

            return `
                <div class="p-3 hover:bg-gray-700 cursor-pointer" onclick="openSearchResult(${inlineArg(item.path)}, ${item.isDirectory})">
                    <div class="flex items-center gap-2">
                        <i data-lucide="${icon}" class="w-5 h-5 ${iconColor}"></i>
                        <div class="flex-1 min-w-0">
                            <div class="font-medium text-gray-100 truncate">${displayName}</div>
                            <div class="text-xs text-gray-400 truncate">${escapeHtml(item.path)}</div>
                        </div>
                    </div>
                    ${contentMatchesHtml}
                </div>
            `;
        }).join('');

        lucide.createIcons();
    }

    showSearchView();
}

function openSearchResult(path, isDirectory) {
    // Just navigate - navigateTo will clear search state
    navigateTo(path, true);
}

function openSearchResultWithLine(path, lineNum, event) {
    event.stopPropagation();
    // Clear search state and navigate to file with line number
    document.getElementById('searchResultsView').classList.add('hidden');
    document.getElementById('searchInput').value = '';
    viewFile(path, true, { start: lineNum, end: lineNum });
}

function showSearchView() {
    editorBaseline = null;
    currentViewingFile = null;
    selectedFiles.clear();
    renderBreadcrumbs();
    updateToolbar();
    document.getElementById('fileListView').classList.add('hidden');
    document.getElementById('fileViewerView').classList.add('hidden');
    document.getElementById('searchResultsView').classList.remove('hidden');
    document.getElementById('toolbar').classList.add('hidden');
    // Keep breadcrumbs visible to show current search location
    viewMode = 'search';
}

async function closeSearch(pushHistory = true) {
    await navigateTo(currentPath, pushHistory);
}

function escapeHtml(text) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(text ?? '').replace(/[&<>"']/g, char => entities[char]);
}

function inlineArg(value) {
    return escapeHtml(JSON.stringify(value));
}

function fileUrlPath(path) {
    return '/' + path.split('/').map(encodeURIComponent).join('/');
}

function highlightText(text, query) {
    const escaped = escapeHtml(text);
    const escapedQuery = escapeHtml(query);
    // Case-insensitive replace with highlight span (green like Firefox)
    const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(regex, '<mark class="bg-green-300 text-green-900 px-0.5 rounded">$1</mark>');
}

// Toast notifications
let toastTimeout = null;

const toastIcons = {
    success: '<i data-lucide="check-circle" class="w-4 h-4 text-green-400"></i>',
    error:   '<i data-lucide="alert-circle" class="w-4 h-4 text-red-400"></i>',
    info:    '<i data-lucide="info" class="w-4 h-4 text-blue-400"></i>'
};

function showToast(message, type = 'info') {
    const container = document.getElementById('toast');
    const inner = container.querySelector('.toast-inner');
    const iconEl = document.getElementById('toastIcon');
    const msgEl = document.getElementById('toastMessage');

    // Clear any pending hide
    if (toastTimeout) {
        clearTimeout(toastTimeout);
        toastTimeout = null;
    }

    // Set content
    iconEl.innerHTML = toastIcons[type] || toastIcons.info;
    msgEl.textContent = message;

    // Set accent color
    inner.classList.remove('toast-accent-success', 'toast-accent-error', 'toast-accent-info');
    inner.classList.add('toast-accent-' + type);

    // Show
    container.classList.add('toast-visible');
    lucide.createIcons({ attrs: { 'stroke-width': 2 }, nameAttr: 'data-lucide' });

    // Auto-hide after 4s
    toastTimeout = setTimeout(() => {
        container.classList.remove('toast-visible');
    }, 4000);
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Check if confirm modal is open first (highest priority)
        if (!document.getElementById('confirmModal').classList.contains('hidden')) {
            closeConfirmModal(false);
            return;
        }
        // Cancel active upload
        if (activeUploader) {
            cancelActiveUpload();
            return;
        }
        // Cancel active download
        if (activeDownloader) {
            cancelActiveDownload();
            return;
        }

        closeNewItemModal();
        closeMoveModal();
        closeRenameModal();
        // If viewing a file, go back to folder
        if (viewMode === 'file') {
            goToParentFolder();
        }
        // If viewing search results, close search
        if (viewMode === 'search') {
            closeSearch();
        }
    }
    if (e.ctrlKey && e.key === 's' && viewMode === 'file' && currentViewingFile && !currentViewingFile.isBinary && !document.getElementById('saveFileBtn').classList.contains('hidden')) {
        e.preventDefault();
        saveCurrentFile();
    }
    // Removed Ctrl+F handler - let browser handle native search
});

// Drag and drop upload
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer.types.includes('Files')) {
        document.getElementById('dropZone').classList.remove('hidden');
        lucide.createIcons();
    }
});

document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        document.getElementById('dropZone').classList.add('hidden');
    }
});

document.addEventListener('dragover', (e) => {
    e.preventDefault();
});

async function collectDroppedEntries(entries) {
    const files = [];
    async function processEntry(entry, path = '') {
        if (entry.isFile) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            files.push({ file, path: path ? `${path}/${file.name}` : file.name });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const folderPath = path ? `${path}/${entry.name}` : entry.name;
            // readEntries returns batches (often only 100 entries). An empty batch
            // is the only indication that the entire directory has been read.
            while (true) {
                const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                if (batch.length === 0) break;
                for (const child of batch) await processEntry(child, folderPath);
            }
        }
    }
    for (const entry of entries) await processEntry(entry);
    return files;
}

document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    document.getElementById('dropZone').classList.add('hidden');
    try {
        const entries = Array.from(e.dataTransfer.items || [])
            .map(item => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)
            .filter(Boolean);
        if (entries.length > 0) {
            const files = await collectDroppedEntries(entries);
            if (files.length > 0) await uploadDroppedFiles(files);
        } else if (e.dataTransfer.files.length > 0) {
            await uploadFiles(e.dataTransfer.files);
        }
    } catch (err) {
        showToast('Could not read dropped files: ' + err.message, 'error');
    }
});

async function uploadDroppedFiles(droppedFiles) {
    // Collect all directories that need to be created
    const dirs = new Set();
    droppedFiles.forEach(f => {
        const parts = f.path.split('/');
        parts.pop(); // Remove filename
        let dirPath = '';
        for (const part of parts) {
            dirPath = dirPath ? `${dirPath}/${part}` : part;
            dirs.add(dirPath);
        }
    });

    // Create directories first (sorted to create parents before children)
    for (const dir of Array.from(dirs).sort()) {
        const parts = dir.split('/');
        const name = parts.pop();
        const parentParts = currentPath ? [currentPath, ...parts] : parts;
        const parent = parentParts.join('/');

        try {
            await api('/api/file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    parent: parent,
                    name: name,
                    isFolder: true
                })
            });
        } catch (error) {
            const existing = await api(`/api/files?path=${encodeURIComponent(parent ? `${parent}/${name}` : name)}`).catch(() => null);
            if (!existing) throw error;
        }
    }

    // Build file list with correct destination paths
    const uploadFileList = droppedFiles.map(({ file, path }) => {
        const targetDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
        const destPath = currentPath ? (targetDir ? `${currentPath}/${targetDir}` : currentPath) : targetDir;
        return { file, destPath };
    });

    const uploader = new ChunkedUploader(uploadFileList, currentPath);
    await uploader.start();
}

// Enter key for search
document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performSearch();
});

// Enter key for modals
document.getElementById('newItemName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createNewItem();
});
document.getElementById('renameName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renameItem();
});

// ============== Confirmation Dialog ==============

let confirmResolve = null;

/**
 * Show a custom confirmation dialog
 * @param {Object} options - Configuration options
 * @param {string} options.title - Dialog title
 * @param {string} options.message - Dialog message
 * @param {string} options.confirmText - Text for confirm button (default: "Confirm")
 * @param {string} options.confirmClass - Button class (default: "bg-red-600 hover:bg-red-700")
 * @returns {Promise<boolean>} - Resolves to true if confirmed, false if cancelled
 */
function showConfirmDialog(options) {
    return new Promise((resolve) => {
        confirmResolve = resolve;

        document.getElementById('confirmTitle').textContent = options.title || 'Confirm Action';
        document.getElementById('confirmMessage').textContent = options.message || 'Are you sure?';

        const confirmBtn = document.getElementById('confirmButton');
        const btnClass = options.confirmClass || 'bg-red-600 hover:bg-red-700';
        document.getElementById('confirmButtonText').textContent = options.confirmText || 'Confirm';
        confirmBtn.className = `px-4 py-2 text-white text-sm rounded ${btnClass}`;

        document.getElementById('confirmModal').classList.remove('hidden');

        setTimeout(() => confirmBtn.focus(), 100);
    });
}

function closeConfirmModal(confirmed) {
    document.getElementById('confirmModal').classList.add('hidden');
    if (confirmResolve) {
        confirmResolve(confirmed);
        confirmResolve = null;
    }
}

// Close confirmation modal on Escape (handled in main keyboard shortcuts section below)

// ===== Full Screen Image Viewer (Mobile) =====

// Open image viewer at index
function openImageViewer(index) {
    if (!Number.isInteger(index) || index < 0 || index >= currentFolderImages.length) return;
    
    currentImageIndex = index;
    const modal = document.getElementById('imageViewerModal');
    const img = document.getElementById('imageViewerImg');
    const counter = document.getElementById('imageViewerCounter');
    const nav = document.getElementById('imageViewerNav');
    
    // Load image
    img.src = `/api/view?path=${encodeURIComponent(currentFolderImages[currentImageIndex])}`;
    
    // Update counter
    counter.textContent = `${currentImageIndex + 1} / ${currentFolderImages.length}`;
    
    // Show/hide nav buttons
    nav.classList.toggle('hidden', currentFolderImages.length <= 1);
    
    // Show modal
    modal.classList.remove('hidden');
    
    // Initialize swipe detection
    initSwipeDetection();
    
    lucide.createIcons();
}

// Close image viewer
function closeImageViewer() {
    document.getElementById('imageViewerModal').classList.add('hidden');
    document.getElementById('imageViewerImg').src = '';
}

// Show previous image
function showPrevImage(event) {
    if (event) event.stopPropagation();
    if (currentFolderImages.length === 0) return;
    
    currentImageIndex = (currentImageIndex - 1 + currentFolderImages.length) % currentFolderImages.length;
    updateImageViewer();
}

// Show next image
function showNextImage(event) {
    if (event) event.stopPropagation();
    if (currentFolderImages.length === 0) return;
    
    currentImageIndex = (currentImageIndex + 1) % currentFolderImages.length;
    updateImageViewer();
}

// Update image viewer content
function updateImageViewer() {
    const img = document.getElementById('imageViewerImg');
    const counter = document.getElementById('imageViewerCounter');
    const nav = document.getElementById('imageViewerNav');
    
    img.src = `/api/view?path=${encodeURIComponent(currentFolderImages[currentImageIndex])}`;
    counter.textContent = `${currentImageIndex + 1} / ${currentFolderImages.length}`;
    nav.classList.toggle('hidden', currentFolderImages.length <= 1);
}

// Handle image viewer click (close on background click)
function handleImageViewerClick(event) {
    if (event.target.id === 'imageViewerContent' || event.target.id === 'imageViewerImg') {
        closeImageViewer();
    }
}

// Swipe detection variables
let touchStartX = 0;
let touchStartY = 0;
let touchEndX = 0;
let touchEndY = 0;
let swipeContainer = null;

// Initialize swipe detection
function initSwipeDetection() {
    const content = document.getElementById('imageViewerContent');
    if (!content) return;
    
    content.addEventListener('touchstart', handleTouchStart, { passive: true });
    content.addEventListener('touchend', handleTouchEnd, { passive: true });
}

// Handle touch start
function handleTouchStart(e) {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}

// Handle touch end
function handleTouchEnd(e) {
    touchEndX = e.changedTouches[0].screenX;
    touchEndY = e.changedTouches[0].screenY;
    handleSwipe();
}

// Handle swipe gesture
function handleSwipe() {
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;
    
    // Check if horizontal swipe (more horizontal than vertical)
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
        if (deltaX > 0) {
            // Swipe right - previous image
            showPrevImage();
        } else {
            // Swipe left - next image
            showNextImage();
        }
    }
}

// Close image viewer on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('imageViewerModal');
        if (!modal.classList.contains('hidden')) {
            closeImageViewer();
        }
    }
    
    // Arrow key navigation in image viewer
    const imageModal = document.getElementById('imageViewerModal');
    if (!imageModal.classList.contains('hidden')) {
        if (e.key === 'ArrowLeft') {
            showPrevImage();
        } else if (e.key === 'ArrowRight') {
            showNextImage();
        }
    }
});

// Initialize mobile view mode on load
document.addEventListener('DOMContentLoaded', () => {
    initMobileViewMode();
});


let lastMobileLayout = isMobile();
window.addEventListener('resize', () => {
    const mobile = isMobile();
    if (mobile !== lastMobileLayout) {
        lastMobileLayout = mobile;
        if (viewMode === 'list') renderFiles();
        updateToolbar();
    }
});
