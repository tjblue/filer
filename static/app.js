// State
let currentPath = '';
let files = [];
let selectedFiles = new Set();
let currentViewingFile = null;
let newItemIsFolder = false;
let renamingPath = null;
let moveDestination = '';
let expandedFolders = new Set();
let viewMode = 'list'; // 'list', 'file', or 'search'
let codeMirrorEditor = null; // CodeMirror instance
let useCodeMirror = false; // Whether current file uses CodeMirror
let sortColumn = 'name'; // Current sort column (null = neutral/no sort)
let sortAscending = true; // Sort direction

// Preview thumbnail sizes per scale setting
const PREVIEW_SIZES = {
    sm: { thumb: 40, icon: 28 },
    md: { thumb: 64, icon: 40 },
    lg: { thumb: 96, icon: 56 }
};

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
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
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
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
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
        await navigateTo(path, false);
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
async function navigateTo(path, pushHistory = true) {
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
        // Reset sort state to neutral
        sortColumn = null;
        sortAscending = true;

        const newUrl = '/' + (currentPath || '');
        if (pushHistory && window.location.pathname !== newUrl) {
            history.pushState({ path: currentPath, type: 'dir' }, '', newUrl);
        }

        showListView();
        renderBreadcrumbs();
        renderFiles();
        updateToolbar();
    } catch (err) {
        // Maybe it's a file, try loading as file
        try {
            await viewFile(path, pushHistory);
        } catch (fileErr) {
            // Neither a valid directory nor file — redirect to root
            showToast(`Not found: /${path}`, 'error');
            if (currentPath !== '' || viewMode !== 'list') {
                history.replaceState({ path: '', type: 'dir' }, '', '/');
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
async function viewFile(path, pushHistory = true, lineRange = null) {
    const fileName = path.split('/').pop();

    // Update current path context (parent folder)
    const pathParts = path.split('/');
    pathParts.pop();
    currentPath = pathParts.join('/');

    // Parse line range from hash if not provided
    if (!lineRange && window.location.hash) {
        lineRange = parseLineHash(window.location.hash);
    }

    // Update URL
    let newUrl = '/' + path;
    if (lineRange) {
        newUrl += '#L' + lineRange.start + (lineRange.end !== lineRange.start ? '-' + lineRange.end : '');
    }
    if (pushHistory && window.location.pathname + window.location.hash !== newUrl) {
        history.pushState({ path: path, type: 'file', lineRange }, '', newUrl);
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
                path: currentViewingFile.path,
                content: content
            })
        });
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
        html += `<span class="breadcrumb cursor-pointer text-blue-400 hover:text-blue-300" onclick="navigateTo('${p}')">${part}</span>`;
    }

    // Show file name in breadcrumbs if viewing a file
    if (fileName) {
        html += `<i data-lucide="chevron-right" class="w-4 h-4 text-gray-500"></i>`;
        html += `<span class="text-gray-100">${fileName}</span>`;
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

// Render file list
function renderFiles() {
    const tbody = document.getElementById('fileList');
    const emptyState = document.getElementById('emptyState');

    updateSortIndicators();

    if (files.length === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    const sortedFiles = getSortedFiles();

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
            iconHtml = `<img src="/api/view?path=${encodeURIComponent(file.path)}" loading="lazy" style="width:${sizes.thumb}px;height:${sizes.thumb}px;" class="object-cover rounded flex-shrink-0">`;
        } else if (!file.isDirectory && isPdf(file.name)) {
            const scale = sizes.thumb / 400;
            iconHtml = `<div class="pdf-thumb" style="width:${sizes.thumb}px;height:${sizes.thumb}px;"><iframe src="/api/view?path=${encodeURIComponent(file.path)}#toolbar=0&navpanes=0&scrollbar=0" loading="lazy" style="transform:scale(${scale});"></iframe></div>`;
        } else {
            iconHtml = `<i data-lucide="${icon}" class="${iconColor}" style="width:${sizes.icon}px;height:${sizes.icon}px;"></i>`;
        }

        return `
            <tr class="file-row border-b border-gray-700 ${selected}" data-path="${file.path}">
                <td class="p-3">
                    <input type="checkbox" class="file-checkbox rounded bg-gray-700 border-gray-600" data-path="${file.path}"
                           ${selected ? 'checked' : ''} onchange="toggleSelect('${file.path}')">
                </td>
                <td class="p-3">
                    <div class="flex items-center gap-2 cursor-pointer" onclick="handleClick('${file.path}', ${file.isDirectory})">
                        ${iconHtml}
                        <span class="text-gray-100 hover:text-blue-400">${file.name}</span>
                    </div>
                </td>
                <td class="p-3 text-sm text-gray-400">${size}</td>
                <td class="p-3 text-sm text-gray-400">${modified}</td>
                <td class="p-3">
                    <div class="flex gap-1 justify-end">
                        ${!file.isDirectory ? `
                            <button onclick="event.stopPropagation(); downloadFile('${file.path}')" class="p-1.5 hover:bg-gray-700 rounded" title="Download">
                                <i data-lucide="download" class="w-4 h-4 text-gray-400"></i>
                            </button>
                        ` : `
                            <span class="p-1.5 w-8"></span>
                        `}
                        <button onclick="event.stopPropagation(); showRenameModal('${file.path}', '${file.name}')" class="p-1.5 hover:bg-gray-700 rounded" title="Rename">
                            <i data-lucide="pen-line" class="w-4 h-4 text-gray-400"></i>
                        </button>
                        <button onclick="event.stopPropagation(); deleteSingle('${file.path}')" class="p-1.5 hover:bg-gray-700 rounded" title="Delete">
                            <i data-lucide="trash-2" class="w-4 h-4 text-red-400"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    lucide.createIcons();
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

function toggleSelectAll() {
    const selectAll = document.getElementById('selectAll');
    if (selectAll.checked) {
        files.forEach(f => selectedFiles.add(f.path));
    } else {
        selectedFiles.clear();
    }
    renderFiles();
    updateToolbar();
}

function updateToolbar() {
    const hasSelection = selectedFiles.size > 0;
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
    document.getElementById('selectAll').checked = selectedFiles.size === files.length && files.length > 0;
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
                await this._downloadWithBlob(url);
            }
        } catch (err) {
            if (this.cancelled || err.name === 'AbortError') {
                showToast('Download cancelled', 'info');
            } else {
                showToast('Download failed: ' + err.message, 'error');
            }
        } finally {
            this._cleanup();
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

        await this.writable.close();
        this.writable = null;

        hideDownloadProgress();
        showToast('Download complete', 'success');
    }

    async _downloadWithBlob(url) {
        const response = await fetch(url, { signal: this.abortController.signal });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);

        const totalSize = parseInt(response.headers.get('Content-Length'), 10) || 0;
        let downloaded = 0;
        let lastTime = performance.now();
        let lastBytes = 0;
        let speed = 0;
        const chunks = [];

        const reader = response.body.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            downloaded += value.byteLength;

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

        // Merge chunks into Blob and trigger download
        const blob = new Blob(chunks);
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = this.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);

        hideDownloadProgress();
        showToast('Download complete', 'success');
    }

    cancel() {
        this.cancelled = true;
        this.abortController.abort();
        this._cleanupWritable();
    }

    async _cleanupWritable() {
        if (this.writable) {
            try { await this.writable.abort(); } catch (e) { /* ignore */ }
            this.writable = null;
        }
    }

    _cleanup() {
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
        // files: array of { file: File, destPath: string }
        this.files = files;
        this.destPath = destPath;
        this.cancelled = false;
        this.activeXHRs = new Set();
        this.currentUploadId = null;
        this.totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
        this.uploadedBytes = 0; // bytes fully uploaded across completed files
        this.chunkProgress = new Map(); // chunk index -> bytes loaded
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

        const totalLabel = this.files.length === 1
            ? this.files[0].file.name
            : `${this.files.length} files`;
        showUploadProgress(totalLabel);

        try {
            for (let i = 0; i < this.files.length; i++) {
                if (this.cancelled) break;
                const { file, destPath } = this.files[i];

                // Update label for current file
                const label = this.files.length === 1
                    ? file.name
                    : `${file.name} (${i + 1}/${this.files.length})`;
                document.getElementById('uploadFileName').textContent = label;
                document.getElementById('uploadFileName').title = label;

                this.chunkProgress = new Map();

                if (file.size < CHUNK_SIZE) {
                    await this._uploadSmall(file, destPath);
                } else {
                    await this._uploadChunked(file, destPath);
                }

                this.uploadedBytes += file.size;
            }

            if (!this.cancelled) {
                showToast(`Uploaded ${this.files.length} file(s)`, 'success');
                refreshFiles();
            }
        } catch (err) {
            if (!this.cancelled) {
                showToast('Upload failed: ' + err.message, 'error');
            }
        } finally {
            hideUploadProgress();
            activeUploader = null;
            this.currentUploadId = null;
        }
    }

    _updateProgress() {
        const currentFileUploaded = [...this.chunkProgress.values()].reduce((a, b) => a + b, 0);
        const totalUploaded = this.uploadedBytes + currentFileUploaded;
        const percent = this.totalBytes ? (totalUploaded / this.totalBytes) * 100 : 0;

        const now = performance.now();
        const elapsed = (now - this.lastTime) / 1000;
        if (elapsed >= 0.2) {
            this.speed = (totalUploaded - this.lastBytes) / elapsed;
            this.lastBytes = totalUploaded;
            this.lastTime = now;
        }

        updateUploadProgress(percent, this.speed, totalUploaded, this.totalBytes);
    }

    async _uploadSmall(file, destPath) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            this.activeXHRs.add(xhr);

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    this.chunkProgress.set('small', e.loaded);
                    this._updateProgress();
                }
            });

            xhr.addEventListener('load', () => {
                this.activeXHRs.delete(xhr);
                if (xhr.status >= 200 && xhr.status < 300) {
                    this.chunkProgress.set('small', file.size);
                    resolve();
                } else {
                    reject(new Error(`Upload failed (${xhr.status})`));
                }
            });

            xhr.addEventListener('error', () => {
                this.activeXHRs.delete(xhr);
                reject(new Error('Network error'));
            });

            xhr.addEventListener('abort', () => {
                this.activeXHRs.delete(xhr);
                reject(new Error('Upload cancelled'));
            });

            const formData = new FormData();
            formData.append('path', destPath);
            formData.append('files', file);

            xhr.open('POST', '/api/upload');
            xhr.send(formData);
        });
    }

    async _uploadChunked(file, destPath) {
        // Init
        const initResp = await fetch('/api/upload/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileName: file.name,
                fileSize: file.size,
                destPath: destPath
            })
        });
        if (!initResp.ok) {
            const err = await initResp.json().catch(() => ({}));
            throw new Error(err.error || `Init failed (${initResp.status})`);
        }
        const { uploadId } = await initResp.json();
        this.currentUploadId = uploadId;

        // Build chunk descriptors
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const chunks = [];
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            chunks.push({ index: i, start, end: Math.min(start + CHUNK_SIZE, file.size) });
        }

        // Shared queue index for workers
        let nextChunk = 0;
        const self = this;

        async function worker() {
            while (!self.cancelled) {
                const ci = nextChunk++;
                if (ci >= chunks.length) break;
                await self._sendChunk(uploadId, file, chunks[ci]);
            }
        }

        // Launch parallel workers
        const workers = [];
        for (let w = 0; w < Math.min(PARALLEL_CHUNKS, totalChunks); w++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        if (this.cancelled) return;

        // Complete
        const completeResp = await fetch('/api/upload/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uploadId: uploadId,
                fileName: file.name,
                destPath: destPath
            })
        });
        if (!completeResp.ok) {
            const err = await completeResp.json().catch(() => ({}));
            throw new Error(err.error || `Complete failed (${completeResp.status})`);
        }
        this.currentUploadId = null;
    }

    _sendChunk(uploadId, file, { index, start, end }) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            this.activeXHRs.add(xhr);

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    this.chunkProgress.set(index, e.loaded);
                    this._updateProgress();
                }
            });

            xhr.addEventListener('load', () => {
                this.activeXHRs.delete(xhr);
                if (xhr.status >= 200 && xhr.status < 300) {
                    this.chunkProgress.set(index, end - start);
                    this._updateProgress();
                    resolve();
                } else {
                    reject(new Error(`Chunk upload failed (${xhr.status})`));
                }
            });

            xhr.addEventListener('error', () => {
                this.activeXHRs.delete(xhr);
                reject(new Error('Network error'));
            });

            xhr.addEventListener('abort', () => {
                this.activeXHRs.delete(xhr);
                reject(new Error('Upload cancelled'));
            });

            const blob = file.slice(start, end);
            const formData = new FormData();
            formData.append('uploadId', uploadId);
            formData.append('chunkIndex', index);
            formData.append('chunk', blob);

            xhr.open('POST', '/api/upload/chunk');
            xhr.send(formData);
        });
    }

    cancel() {
        this.cancelled = true;
        for (const xhr of this.activeXHRs) {
            xhr.abort();
        }
        this.activeXHRs.clear();
        // Cancel server-side if we have an active chunked upload
        if (this.currentUploadId) {
            fetch('/api/upload/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId: this.currentUploadId })
            }).catch(() => {});
            this.currentUploadId = null;
        }
        showToast('Upload cancelled', 'info');
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
        showToast(`Deleted ${result.deleted.length} item(s)`, 'success');
        refreshFiles();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Move
async function showMoveModal() {
    if (selectedFiles.size === 0) return;

    moveDestination = '';
    document.getElementById('moveDestinationDisplay').textContent = 'Root';
    document.getElementById('moveModal').classList.remove('hidden');

    // Fetch folder tree, excluding selected items
    const excludeParams = Array.from(selectedFiles).map(p => `exclude=${encodeURIComponent(p)}`).join('&');
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
             onclick="selectMoveDestination('', 'Root')">
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
        const escapedPath = folder.path.replace(/'/g, "\\'");

        const chevron = hasChildren
            ? `<i data-lucide="${isExpanded ? 'chevron-down' : 'chevron-right'}" data-folder-chevron="${folder.path}" class="w-4 h-4 text-gray-400 shrink-0 cursor-pointer" onclick="toggleFolder('${escapedPath}', event)"></i>`
            : `<span class="w-4 h-4 shrink-0"></span>`;

        html += `
            <div class="folder-item flex items-center gap-1 p-2 rounded cursor-pointer hover:bg-gray-700 ${isSelected ? 'bg-gray-700' : ''}"
                 onclick="selectMoveDestination('${escapedPath}', '${folder.name.replace(/'/g, "\\'")}')">
                ${chevron}
                <i data-lucide="folder" class="w-4 h-4 text-yellow-400 shrink-0"></i>
                <span class="text-gray-200 text-sm">${folder.name}</span>
            </div>
        `;

        if (hasChildren) {
            html += `<div id="folder-children-${folder.path}" class="ml-2 pl-2 border-l border-gray-700 ${isExpanded ? '' : 'hidden'}">${renderFolderLevel(folder.children)}</div>`;
        }
    }

    return html;
}

function selectMoveDestination(path, name) {
    moveDestination = path;
    document.getElementById('moveDestinationDisplay').textContent = path || 'Root';

    // Update visual selection
    document.querySelectorAll('#folderTree .folder-item').forEach(el => {
        el.classList.remove('bg-gray-700');
    });
    event.currentTarget.classList.add('bg-gray-700');
}

function closeMoveModal() {
    document.getElementById('moveModal').classList.add('hidden');
}

async function moveSelected() {
    const items = Array.from(selectedFiles).map(source => {
        const name = source.split('/').pop();
        return {
            source,
            destination: moveDestination ? `${moveDestination}/${name}` : name
        };
    });

    try {
        const result = await api('/api/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        closeMoveModal();
        showToast(`Moved ${result.moved.length} item(s)`, 'success');
        refreshFiles();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

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

    try {
        const params = new URLSearchParams({
            q: query,
            path: currentPath,
            content: 'true'
        });

        const data = await api(`/api/search?${params}`);

        // Update URL with search query
        if (pushHistory) {
            const newUrl = '/' + (currentPath || '') + '?q=' + encodeURIComponent(query);
            history.pushState({ type: 'search', query, path: currentPath }, '', newUrl);
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
                            <div class="text-xs bg-gray-900 p-2 rounded font-mono text-gray-300 cursor-pointer hover:bg-gray-800" onclick="openSearchResultWithLine('${item.path}', ${m.line}, event)">
                                <span class="text-blue-400 hover:text-blue-300">Line ${m.line}:</span> ${highlightText(m.text, data.query)}
                            </div>
                        `).join('')}
                    </div>
                `;
            }

            const displayName = item.nameMatch ? highlightText(item.name, data.query) : escapeHtml(item.name);

            return `
                <div class="p-3 hover:bg-gray-700 cursor-pointer" onclick="openSearchResult('${item.path}', ${item.isDirectory})">
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
    document.getElementById('fileListView').classList.add('hidden');
    document.getElementById('fileViewerView').classList.add('hidden');
    document.getElementById('searchResultsView').classList.remove('hidden');
    document.getElementById('toolbar').classList.add('hidden');
    // Keep breadcrumbs visible to show current search location
    viewMode = 'search';
}

function closeSearch(pushHistory = true) {
    document.getElementById('searchResultsView').classList.add('hidden');
    document.getElementById('searchInput').value = '';
    document.getElementById('breadcrumbsBar').classList.remove('hidden');

    // Update URL to remove search params
    if (pushHistory) {
        const newUrl = '/' + (currentPath || '');
        history.pushState({ type: 'dir', path: currentPath }, '', newUrl);
    }

    showListView();
    renderFiles();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    document.getElementById('dropZone').classList.add('hidden');

    const items = e.dataTransfer.items;
    const files = [];

    // Process all items (including folders)
    const processEntry = async (entry, path = '') => {
        if (entry.isFile) {
            return new Promise((resolve) => {
                entry.file((file) => {
                    // Preserve folder structure in file path
                    const filePath = path ? `${path}/${file.name}` : file.name;
                    files.push({ file, path: filePath });
                    resolve();
                });
            });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const entries = await new Promise((resolve) => {
                reader.readEntries(resolve);
            });
            const folderPath = path ? `${path}/${entry.name}` : entry.name;
            for (const childEntry of entries) {
                await processEntry(childEntry, folderPath);
            }
        }
    };

    // Get all entries
    const entries = [];
    for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) {
            entries.push(entry);
        }
    }

    // Process entries
    for (const entry of entries) {
        await processEntry(entry);
    }

    if (files.length === 0) return;

    // Upload files
    await uploadDroppedFiles(files);
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
        } catch (e) {
            // Directory might already exist, ignore
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

