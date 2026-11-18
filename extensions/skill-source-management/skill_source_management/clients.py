"""Discovery views, not permission or native-plugin lifecycle management."""
from pathlib import Path

from .errors import ManagementError

ROOTS = {'codex': '.codex/skills', 'claude-code': '.claude/skills'}


def view(home, source_root, client, name):
    if not isinstance(client, str) or client not in ROOTS:
        raise ManagementError('Supported clients are codex and claude-code')
    native = home / ROOTS[client] / name
    mode = 'direct' if client == 'codex' and source_root == home / '.agents/skills' else 'symlink'
    return {'client': client, 'name': name, 'mode': mode, 'path': str(native),
            'source_path': str(source_root / name)}
