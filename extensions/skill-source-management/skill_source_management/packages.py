"""Inspect/copy complete standalone packages without executing their code."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat

from .errors import ManagementError

IGNORED = {'.git', '.DS_Store', '__pycache__'}
FORBIDDEN = {'.venv', 'venv', 'node_modules', '.env', '.credentials.yaml',
             'auth.json', 'id_rsa', 'id_ed25519'}
MAX_BYTES = 64 * 1024 * 1024


def ignored(name):
    return name in IGNORED or name.endswith(('.pyc', '.pyo'))


def valid_name(name):
    return isinstance(name, str) and len(name) <= 64 and bool(re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name))


def _scalar(value):
    return value.strip().strip('"\'')


def _metadata(root):
    entry = root / 'SKILL.md'
    if entry.is_symlink() or not entry.is_file() or entry.stat().st_size > 1024 * 1024:
        raise ManagementError('A standalone package requires a real SKILL.md up to 1 MiB')
    try:
        text = entry.read_text(encoding='utf8')
    except UnicodeError as error:
        raise ManagementError('SKILL.md must be UTF-8') from error
    match = re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)', text, re.S)
    if not match:
        raise ManagementError('SKILL.md requires YAML frontmatter')
    header = match.group(1)
    values = {}
    for key in ['name', 'description', 'version', 'license']:
        found = re.search(r'^' + key + r':[^\S\r\n]*(.*?)$', header, re.M)
        if found:
            value = _scalar(found.group(1))
            if value in ['|', '>']:
                rest = header[found.end():]
                block = re.match(r'\n((?:[ \t]+[^\n]*(?:\n|$))+)', rest)
                value = ' '.join(line.strip() for line in block.group(1).splitlines()) if block else ''
            values[key] = value
    if not valid_name(values.get('name')) or not values.get('description'):
        raise ManagementError('Skill needs a valid lowercase name and nonempty description')
    versions = {}
    if values.get('version'):
        versions['frontmatter.version'] = values['version']
    nested = re.search(r'^metadata:[^\S\r\n]*\n((?:[ \t]+[^\n]*(?:\n|$))+)', header, re.M)
    if nested:
        found = re.search(r'^[ \t]+version:[^\S\r\n]*(.*?)$', nested.group(1), re.M)
        if found:
            versions['metadata.version'] = _scalar(found.group(1))
    return {'name': values['name'], 'description': values['description'],
            'versions': versions, 'license': values.get('license')}


def inspect_package(path):
    path = Path(path).expanduser().absolute()
    if path.is_symlink() or not path.is_dir():
        raise ManagementError('Candidate must be a real standalone Skill directory')
    root = path.resolve(strict=True)
    metadata = _metadata(root)
    if root.name != metadata['name']:
        raise ManagementError('Skill name must match its package directory')
    nodes = {}
    total = 0

    def visit(directory):
        nonlocal total
        for item in sorted(directory.iterdir(), key=lambda p: p.name):
            if ignored(item.name):
                continue
            if item.name in {'.claude-plugin', '.codex-plugin', '.plugin-source.json'} or (item.name == 'SKILL.md' and item.parent != root):
                raise ManagementError('Plugin or nested Skill publication units require a separate adapter')
            if item.name in FORBIDDEN or item.name.startswith('.env.'):
                raise ManagementError('Runtime or credential payload cannot be published')
            info = item.lstat()
            relative = item.relative_to(root).as_posix()
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(item)
                try:
                    resolved = item.resolve(strict=True)
                except (OSError, RuntimeError) as error:
                    raise ManagementError('Broken or cyclic package symlink') from error
                if os.path.isabs(target) or not resolved.is_relative_to(root):
                    raise ManagementError('Package symlink escapes its publication unit')
                nodes[relative] = {'kind': 'symlink', 'target': target, 'mode': mode}
            elif stat.S_ISDIR(info.st_mode):
                nodes[relative] = {'kind': 'directory', 'mode': mode}
                visit(item)
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > MAX_BYTES:
                    raise ManagementError('Standalone package exceeds the 64 MiB bound')
                digest = hashlib.sha256()
                with item.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(65536), b''):
                        digest.update(chunk)
                nodes[relative] = {'kind': 'file', 'mode': mode, 'sha256': digest.hexdigest()}
            else:
                raise ManagementError('Unsupported package filesystem object')
            if len(nodes) > 10000:
                raise ManagementError('Standalone package exceeds the entry-count bound')

    nodes['.'] = {'kind': 'directory', 'mode': stat.S_IMODE(root.stat().st_mode)}
    visit(root)
    encoded = json.dumps(nodes, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return {**metadata, 'digest': hashlib.sha256(encoded).hexdigest(), 'nodes': nodes}


def copy_package(source, destination, expected):
    if inspect_package(source)['digest'] != expected:
        raise ManagementError('Reviewed candidate changed')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copytree(source, destination, symlinks=True,
                    ignore=lambda _dir, names: [name for name in names if ignored(name)])
    if inspect_package(destination)['digest'] != expected or inspect_package(source)['digest'] != expected:
        raise ManagementError('Candidate changed during copy; retained payload needs inspection')
