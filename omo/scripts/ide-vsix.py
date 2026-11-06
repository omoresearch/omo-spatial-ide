#!/usr/bin/env python3
"""Expand a verified VSIX into the directory layout Theia system plugins require."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile


def expand(archive, target):
    target = Path(target)
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > 100000 or sum(entry.file_size for entry in entries) > 512 * 1024 * 1024:
            raise ValueError('VSIX exceeds extraction limits')
        seen = set()
        for entry in entries:
            name = entry.filename
            parts = PurePosixPath(name).parts
            mode = entry.external_attr >> 16
            if (not parts or name.startswith('/') or '\\' in name or any(':' in part for part in parts)
                    or any(not part or part in ('.', '..') for part in name.rstrip('/').split('/'))
                    or any(ord(char) < 32 for char in name) or name in seen
                    or entry.file_size < 0 or entry.file_size > 100000000
                    or stat.S_ISLNK(mode) or entry.flag_bits & 1):
                raise ValueError('Unsafe VSIX member')
            seen.add(name)
        info = bundle.getinfo('extension/package.json')
        if info.file_size > 1024 * 1024:
            raise ValueError('Extension manifest is too large')
        package = json.loads(bundle.read(info))
        plugin_id = str(package.get('publisher', '')) + '.' + str(package.get('name', ''))
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', plugin_id) or not package.get('publisher') or not package.get('name'):
            raise ValueError('Extension identity is invalid')
        destination = target / plugin_id
        if destination.exists() or destination.is_symlink():
            raise ValueError('Duplicate extension identity')
        destination.mkdir(mode=0o755)
        files = {}
        for entry in entries:
            if not entry.filename.startswith('extension/') or entry.is_dir():
                continue
            relative = entry.filename[len('extension/'):]
            if not relative:
                continue
            output = destination / relative
            output.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with bundle.open(entry) as reader, output.open('xb') as writer:
                while True:
                    chunk = reader.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    writer.write(chunk)
            output.chmod(0o644 | ((entry.external_attr >> 16) & 0o111))
            files[plugin_id + '/' + relative] = digest.hexdigest()
        return {'id': plugin_id, 'version': str(package.get('version', '')), 'files': files}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Expected archive and target directory')
        print(json.dumps(expand(sys.argv[1], sys.argv[2])))
    except Exception as error:
        print(type(error).__name__ + ': VSIX extraction refused', file=sys.stderr)
        sys.exit(1)
