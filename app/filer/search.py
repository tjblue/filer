"""
File search functionality - ripgrep integration with Python fallback.
"""

import os
import json
import subprocess
from pathlib import Path
from datetime import datetime
from flask import current_app


def search_with_ripgrep(query: str, search_path: Path, max_results: int) -> list | None:
    """Search using ripgrep. Returns None if rg is not available."""
    ROOT_DIR = current_app.config['ROOT_DIR']

    try:
        # Run ripgrep with JSON output
        result = subprocess.run(
            [
                'rg', '--json', '-i', '-F',   # Literal, case-insensitive search
                '--max-count', '3',           # Max 3 matches per file
                '--max-filesize', '10M',      # Skip files over 10MB
                '--no-ignore',               # Match the Python fallback's scope
                '-g', '!.*',                  # Skip hidden files
                '--', query, str(search_path)
            ],
            capture_output=True, text=True, timeout=30
        )
    except FileNotFoundError:
        return None  # ripgrep not installed
    except subprocess.TimeoutExpired:
        return None

    if result.returncode not in (0, 1):
        return None

    results = []
    file_matches = {}  # path -> list of matches

    for line in result.stdout.strip().split('\n'):
        if not line:
            continue
        try:
            data = json.loads(line)
            if data['type'] == 'match':
                file_path = data['data']['path']['text']
                line_num = data['data']['line_number']
                line_text = data['data']['lines']['text'].strip()[:200]

                if file_path not in file_matches:
                    file_matches[file_path] = []
                if len(file_matches[file_path]) < 3:
                    file_matches[file_path].append({
                        'line': line_num,
                        'text': line_text
                    })
        except (json.JSONDecodeError, KeyError):
            continue

    # Convert to result format
    query_lower = query.lower()
    for file_path, matches in file_matches.items():
        if len(results) >= max_results:
            break
        try:
            filepath = Path(file_path)
            rel_path = str(filepath.relative_to(ROOT_DIR)).replace('\\', '/')
            stat = filepath.stat()
            name_match = query_lower in filepath.name.lower()
            results.append({
                'name': filepath.name,
                'path': rel_path,
                'isDirectory': False,
                'size': stat.st_size,
                'modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
                'nameMatch': name_match,
                'contentMatches': matches
            })
        except (OSError, ValueError):
            continue

    # Also find files that match by name but weren't found by content search
    try:
        for root, dirs, files in os.walk(search_path):
            if len(results) >= max_results:
                break
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for filename in files:
                if len(results) >= max_results:
                    break
                if filename.startswith('.'):
                    continue
                if query_lower in filename.lower():
                    filepath = Path(root) / filename
                    file_path_str = str(filepath)
                    # Skip if already in results from content search
                    if file_path_str in file_matches:
                        continue
                    try:
                        rel_path = str(filepath.relative_to(ROOT_DIR)).replace('\\', '/')
                        stat = filepath.stat()
                        results.append({
                            'name': filename,
                            'path': rel_path,
                            'isDirectory': False,
                            'size': stat.st_size,
                            'modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
                            'nameMatch': True,
                            'contentMatches': []
                        })
                    except (OSError, ValueError):
                        continue
    except PermissionError:
        pass

    return results


def search_with_python(query: str, search_path: Path, max_results: int) -> list:
    """Fallback Python-based search."""
    ROOT_DIR = current_app.config['ROOT_DIR']
    results = []
    query_lower = query.lower()
    max_file_size = 10 * 1024 * 1024

    binary_extensions = {'.pdf', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg',
                         '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dll', '.so',
                         '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg',
                         '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pyc'}

    try:
        for root, dirs, files in os.walk(search_path):
            dirs[:] = [d for d in dirs if not d.startswith('.')]

            for filename in files:
                if len(results) >= max_results:
                    break
                if filename.startswith('.'):
                    continue

                filepath = Path(root) / filename
                rel_path = str(filepath.relative_to(ROOT_DIR)).replace('\\', '/')
                name_match = query_lower in filename.lower()

                content_matches = []
                if not name_match:
                    ext = filepath.suffix.lower()
                    if ext not in binary_extensions:
                        try:
                            if filepath.stat().st_size <= max_file_size:
                                with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                                    for line_num, line in enumerate(f, 1):
                                        if query_lower in line.lower():
                                            content_matches.append({
                                                'line': line_num,
                                                'text': line.strip()[:200]
                                            })
                                            if len(content_matches) >= 3:
                                                break
                        except (PermissionError, OSError):
                            pass

                if name_match or content_matches:
                    stat = filepath.stat()
                    results.append({
                        'name': filename,
                        'path': rel_path,
                        'isDirectory': False,
                        'size': stat.st_size,
                        'modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        'nameMatch': name_match,
                        'contentMatches': content_matches
                    })

            if len(results) >= max_results:
                break
    except PermissionError:
        pass

    return results
