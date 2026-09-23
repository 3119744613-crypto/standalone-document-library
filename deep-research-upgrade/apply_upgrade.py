#!/usr/bin/env python3
"""Check/apply a local additive upgrade. No network, database, install, commit or push."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys

PATCH_ALLOWED = {'.gitignore', 'README.md', 'apps/web/src/main.jsx', 'apps/web/vite.config.js'}
FIXED_ALLOWED = {'apps/web/general.html', 'apps/web/src/general-main.jsx', 'apps/web/vite.general.config.js', 'apps/web/src/features/deep-thinking/deep-event-stream.js'}
DENIED = {'.git', '.runtime', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.build', 'build', 'dist', 'dist-general', 'coverage'}
DENIED_SUFFIXES = ('.pyc', '.pyo', '.log', '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3', '.sqlite-wal', '.sqlite-shm', '.pem', '.key')


def fail(message):
    raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_relative(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or any(ord(character) < 32 for character in value):
        fail('Invalid manifest path.')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('', '.', '..') for part in path.parts) or path.as_posix() != value:
        fail('Unsafe manifest path: ' + value)
    return path


def overlay_allowed(value):
    path = safe_relative(value)
    name = path.name
    if any(part in DENIED for part in path.parts) or name.lower().endswith(DENIED_SUFFIXES) or name == '.DS_Store' or name.startswith('.env') and name != '.env.example':
        return False
    return value in FIXED_ALLOWED or value.startswith('apps/general-research/') or value.startswith('apps/web/src/features/general-research/') or value.startswith('docs/GENERAL_RESEARCH_') and path.parent.as_posix() == 'docs' and name.endswith('.md')


def safe_path(root, relative):
    current = root
    for part in safe_relative(relative).parts:
        current = current / part
        if current.is_symlink():
            fail('Symlink target rejected: ' + relative)
    return current


def git(root, *args, accepted=(0,)):
    result = subprocess.run(['git', *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode not in accepted:
        fail('git ' + args[0] + ' failed: ' + result.stderr.decode('utf-8', 'replace').strip())
    return result


def read_regular(root, relative):
    file = safe_path(root, relative)
    if not file.is_file() or not stat.S_ISREG(file.stat().st_mode):
        fail('Expected a regular file: ' + relative)
    return file.read_bytes()


def verify_package(package):
    manifest = json.loads(read_regular(package, 'manifest.sha256.json'))
    if manifest.get('format') != 1 or not isinstance(manifest.get('files'), list):
        fail('Unsupported manifest.')
    records = {}
    for record in manifest['files']:
        relative = record.get('path')
        safe_relative(relative)
        if relative in records or relative == 'manifest.sha256.json':
            fail('Duplicate or self-referencing manifest entry.')
        if relative not in ('README.md', 'apply_upgrade.py', 'navigation.patch') and not (relative.startswith('overlay/') and overlay_allowed(relative[8:])):
            fail('Unexpected delivery file: ' + relative)
        data = read_regular(package, relative)
        if record.get('size') != len(data) or record.get('sha256') != sha(data) or record.get('mode') not in ('0644', '0755'):
            fail('Delivery checksum/size/mode mismatch: ' + relative)
        records[relative] = record
    actual = set()
    for root, dirs, files in os.walk(package, followlinks=False):
        for name in dirs + files:
            if (Path(root) / name).is_symlink():
                fail('Delivery package contains a symlink.')
        for name in files:
            actual.add((Path(root) / name).relative_to(package).as_posix())
    if actual != set(records) | {'manifest.sha256.json'}:
        fail('The delivery file set differs from the SHA256 manifest.')
    if not {'README.md', 'apply_upgrade.py', 'navigation.patch'}.issubset(records):
        fail('Incomplete delivery package.')
    patch_records = manifest.get('patch_files')
    if not isinstance(patch_records, list):
        fail('Missing patch preimage/postimage checksums.')
    seen = set()
    for record in patch_records:
        if record.get('path') not in PATCH_ALLOWED or record['path'] in seen:
            fail('Unexpected or duplicate navigation patch target.')
        seen.add(record['path'])
        for key in ('before_sha256', 'after_sha256'):
            value = record.get(key, '')
            if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
                fail('Invalid patch checksum.')
    return manifest, records


def preflight(target, package, manifest, records):
    actual_root = Path(git(target, 'rev-parse', '--show-toplevel').stdout.decode().strip()).resolve()
    if actual_root != target:
        fail('Pass the Git repository root, not a subdirectory.')
    overlay = sorted(path[8:] for path in records if path.startswith('overlay/'))
    patch_paths = sorted(record['path'] for record in manifest['patch_files'])
    # Refuse tracked changes before considering any writes, including staged changes.
    dirty = git(target, 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--', *(overlay + patch_paths)).stdout
    if dirty:
        fail('Affected tracked paths have uncommitted changes. Preserve/review them before applying; no files were changed.')
    todo, identical = [], []
    for relative in overlay:
        path = safe_path(target, relative)
        if path.exists():
            if not path.is_file() or sha(read_regular(target, relative)) != records['overlay/' + relative]['sha256']:
                fail('New-file conflict; refusing to overwrite: ' + relative)
            identical.append(relative)
        else:
            # A blocking non-directory ancestor must fail before Git applies its patch.
            for ancestor in path.parents:
                if ancestor == target:
                    break
                if ancestor.exists() and not ancestor.is_dir():
                    fail('A file blocks a new directory: ' + relative)
            todo.append(relative)
    patch = package / 'navigation.patch'
    numstat = git(target, 'apply', '--numstat', '-z', str(patch)).stdout
    parsed = []
    for entry in numstat.split(b'\x00'):
        if not entry:
            continue
        pieces = entry.split(b'\t', 2)
        if len(pieces) != 3 or not pieces[2]:
            fail('Rename/binary/unrecognized navigation patch is not allowed.')
        parsed.append(pieces[2].decode('utf-8'))
    if sorted(parsed) != patch_paths:
        fail('Patch paths do not match the allowlisted manifest.')
    before = {}
    current_hashes = {}
    for record in manifest['patch_files']:
        relative = record['path']
        before[relative] = read_regular(target, relative)
        current_hashes[relative] = sha(before[relative])
    pristine = all(current_hashes[r['path']] == r['before_sha256'] for r in manifest['patch_files'])
    applied = all(current_hashes[r['path']] == r['after_sha256'] for r in manifest['patch_files'])
    if pristine:
        git(target, 'apply', '--check', '--whitespace=error-all', str(patch))
        patch_action = 'apply'
    elif applied:
        git(target, 'apply', '--reverse', '--check', str(patch))
        patch_action = 'already-applied'
    else:
        fail('Navigation files differ from both the reviewed baseline and the complete upgrade. Resolve the version mismatch in a separate checkout; no files were changed.')
    return todo, identical, patch_action, before


def apply_checked(target, package, manifest, records):
    # Repeat all preconditions immediately before writing.
    todo, identical, action, before = preflight(target, package, manifest, records)
    created, made_dirs = [], []
    patch_started = False
    try:
        if action == 'apply':
            patch_started = True
            git(target, 'apply', '--whitespace=error-all', str(package / 'navigation.patch'))
        for relative in todo:
            destination = safe_path(target, relative)
            absent_dirs = []
            parent = destination.parent
            while parent != target and not parent.exists():
                absent_dirs.append(parent)
                parent = parent.parent
            for directory in reversed(absent_dirs):
                directory.mkdir()
                made_dirs.append(directory)
            safe_path(target, relative)
            data = read_regular(package, 'overlay/' + relative)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
            descriptor = os.open(destination, flags, int(records['overlay/' + relative]['mode'], 8))
            created.append(relative)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        for record in manifest['patch_files']:
            if sha(read_regular(target, record['path'])) != record['after_sha256']:
                fail('Navigation patch postimage mismatch: ' + record['path'])
        for relative in todo + identical:
            if sha(read_regular(target, relative)) != records['overlay/' + relative]['sha256']:
                fail('Overlay postimage mismatch: ' + relative)
    except Exception as cause:
        unresolved = []
        # Roll back only bytes created by this run; preserve concurrently changed files.
        for relative in reversed(created):
            try:
                path = safe_path(target, relative)
                if sha(read_regular(target, relative)) == records['overlay/' + relative]['sha256']:
                    path.unlink()
                else:
                    unresolved.append(relative)
            except Exception:
                unresolved.append(relative)
        if patch_started:
            for record in manifest['patch_files']:
                relative = record['path']
                try:
                    current = sha(read_regular(target, relative))
                    if current == record['after_sha256']:
                        safe_path(target, relative).write_bytes(before[relative])
                    elif current != record['before_sha256']:
                        unresolved.append(relative)
                except Exception:
                    unresolved.append(relative)
        for directory in reversed(made_dirs):
            try:
                directory.rmdir()
            except OSError:
                pass
        suffix = ' Preserved files needing manual review: ' + ', '.join(unresolved) if unresolved else ' Changes from this failed run were rolled back.'
        fail(str(cause) + suffix)
    return {'new_files_written': len(todo), 'identical_files_preserved': len(identical), 'navigation': action}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', type=Path, help='Existing Deep Research clone root')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--check', action='store_true', help='Check only; this is the default')
    group.add_argument('--apply', action='store_true', help='Apply after all checks; never commits or installs')
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    target = args.target.expanduser().resolve()
    if not target.is_dir() or target == package or package in target.parents or target in package.parents:
        fail('Choose a separate existing Git clone as the target.')
    manifest, records = verify_package(package)
    todo, identical, action, _ = preflight(target, package, manifest, records)
    result = {'mode': 'apply' if args.apply else 'check', 'target': str(target), 'baseline': manifest['upstream_commit'], 'new_files': len(todo), 'identical_files': len(identical), 'navigation': action}
    if args.apply:
        result.update(apply_checked(target, package, manifest, records))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print('No databases, private configuration, dependencies or Git commits were changed by this tool.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Upgrade stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
