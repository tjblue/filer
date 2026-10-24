# Filer

A directory-based file manager with file browsing, editing, search, expiring
file and text sharing (Napkins), and recoverable Trash.

## Install

Requires Python 3.14 or newer. From this directory, install with uv:

```sh
uv sync --group dev
```

If uv is not installed:

```sh
python -m pip install uv
uv sync --group dev
```

## Run

```sh
uv run python server.py --root /path/to/files
```

You can also run `python server.py --root /path/to/files` from the activated environment.
Open http://127.0.0.1:5000/. Napkins is at `/napkins/`, Trash at `/trash/`,
and settings at `/settings/`.

Options:

- `--root`, `-r`: directory to manage (default: current directory).
- `--host`, `-H`: bind address (default: `127.0.0.1`).
- `--port`, `-p`: port (default: `5000`).
- `--debug`: enable Flask's development debugger; restricted to localhost.
- `--production`: use the bundled Waitress server on Windows, Linux, or macOS.

For a threaded production server:

```sh
uv run python server.py --production --root /path/to/files --port 8080
```

Use a single server process with threads: upload sessions use an in-process cache
backed by disk checkpoints. Keep the same served root and data directory after a
restart. To resume an interrupted chunked upload, select the same unchanged file
again in the same browser and destination folder. Received chunks are skipped;
transient chunk failures are retried automatically. Resume depends on browser
local storage being available. Changing the file's name, size, or modification
time starts a new upload.

Cancel removes the current staging file and checkpoint. Interrupted sessions
expire after 24 hours and are cleaned when another upload starts. Failed or
cancelled uploads preserve existing files; successful uploads keep both files
when names collide. Staging files use `.filer-*.part` names. Files left by older
versions, or a process crash before the initial checkpoint was saved, can require
manual cleanup when no uploads are running.

ZIP archives are built in temporary files under `data/archives/`, keeping archive
contents out of server RAM. The temporary file is removed when the response closes.
Allow enough free disk space for the archive. Browsers with streaming file access
show progress inside Filer; other browsers use their native download manager for
progress and cancellation instead of buffering the whole download in JavaScript.

## Copy, move, and ZIP tools

Select items and choose Copy, or use Cut selected under More (Actions on mobile).
Open a destination folder and choose Paste to select the destination and conflict
policy. Keyboard shortcuts Ctrl/Cmd+C, X, and V work outside text inputs and the
file editor. The clipboard stays in the current browser tab. Duplicate selected
creates numbered copies alongside the originals.

The destination picker offers Skip, Keep both, and Replace for all name conflicts.
Replace moves the existing item to Trash first; folders are replaced whole, not
merged. Copies are staged before an existing destination is touched. To recover a
replaced item from Trash, first move or rename the replacement out of its original
location. Copying links, junctions, and special files is unsupported. Move requires
source and destination to be on the same filesystem.

Open a ZIP file, or select one and choose Browse / extract ZIP under More or Actions.
Select files or folder entries and enter a new extraction folder path relative to
the served root. The parent folder must exist; extraction never overwrites an
existing folder. ZIPs are limited to 10,000 entries and 5 GiB total uncompressed
contents. Encrypted ZIPs, links, ambiguous names, and unsafe paths are rejected.
Extraction is staged and published only after all selected contents pass CRC checks.
Copy and extraction run synchronously; large operations can take time and require
enough disk space for staging. A process crash can leave hidden `.filer-copy-*` or
`.filer-extract-*` directories that need manual cleanup when no operations are running.

## Access and storage

Filer has no built-in authentication. Every client that can reach it can read
and modify the served directory, shared items, and Trash. Keep the default local
binding, or place it behind an authenticated reverse proxy with HTTPS before
making it accessible to other users. Enable network access explicitly with
`--host`; the debugger cannot be enabled on a network binding.

Quick Transfer uploads, JSON metadata, Trash, and settings live under `data/`
relative to the working directory. Start from the project directory consistently,
and prefer a served root outside the project so application data is not exposed
through the file browser. Napkins, Trash, and settings updates use cross-process
locks and atomic writes. Upload checkpoints are stored under `data/upload_sessions/`.
The CLI starts expiration cleanup for Napkins and Trash every five minutes.
Napkins items default to two hours and expire after at most seven days; Trash
retention is 14 days.

Trash records the original served root for each new item. To restore an item,
run Filer with that same `--root`. Older Trash records lack this information;
their destination cannot be determined safely, so recover their contents manually
from `data/trash/<trash_id>/`. Failed deletions remain listed for retry.

ZIP downloads preserve paths relative to the served root, so identically named
files from different folders remain separate.

Configuration constants are in `app/config.py`. Chunked uploads use 5 MiB chunks
and permit files up to 5 GiB. The same per-file limit applies to simple multipart
uploads and Napkins. Requests are limited to that size plus 16 MiB of multipart
overhead. The CLI applies the request limit to Waitress as well. Configure matching
limits and timeouts at a reverse proxy when using one.

## Tests

```sh
uv run pytest -q
```

Frontend regression tests use Node.js's built-in test runner (no npm dependencies):

```sh
node --test tests/frontend.test.cjs
```

Search uses ripgrep when installed and otherwise falls back to Python.
The frontend uses vanilla JavaScript, Tailwind CSS, and Lucide icons.
