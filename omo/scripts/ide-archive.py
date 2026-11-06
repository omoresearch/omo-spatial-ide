#!/usr/bin/env python3
"""Validate a pinned, flat VSIX bundle before writing any extracted member."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile


def extract(archive, target, excluded):
    target = Path(target)
    if target.exists():
        raise ValueError('Extraction target must not already exist')
    excluded = set(excluded)
    files = {}
    with tarfile.open(archive, 'r:gz') as bundle:
        members = []
        seen = set()
        total = 0
        for member in bundle:
            total += member.size
            if len(members) >= 512 or total > 512 * 1024 * 1024:
                raise ValueError('Extension bundle exceeds its safe extraction limit')
            if not member.isfile() or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*\.vsix', member.name):
                raise ValueError('Extension bundle contains an unsafe member')
            if member.name in seen or member.size < 0 or member.size > 100_000_000:
                raise ValueError('Extension bundle contains a duplicate or oversized member')
            seen.add(member.name)
            members.append(member)
        target.mkdir(mode=0o700, parents=False)
        for member in members:
            if member.name[:-5] in excluded:
                continue
            reader = bundle.extractfile(member)
            if reader is None:
                raise ValueError('Extension member could not be read')
            destination = target / member.name
            digest = hashlib.sha256()
            with destination.open('xb') as output:
                while True:
                    chunk = reader.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    output.write(chunk)
            files[member.name] = digest.hexdigest()
    return files


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise ValueError('Expected archive, target and excluded-ID JSON')
        print(json.dumps(extract(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))))
    except Exception as error:
        print(type(error).__name__ + ': extension bundle extraction refused', file=sys.stderr)
        sys.exit(1)
