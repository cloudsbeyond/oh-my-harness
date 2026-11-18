"""Guarded writes: explicit platform strategy, no privilege or permission changes."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid

from .errors import ManagementError


def require_supported():
    if sys.platform != 'darwin':
        raise ManagementError('Guarded lifecycle writes currently support macOS only')


def _rename(source, destination, flags):
    require_supported()
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(source), os.fsencode(destination), flags) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def rename_no_replace(source, destination):
    _rename(source, destination, 0x4)  # Darwin RENAME_EXCL.


def exchange(source, destination):
    _rename(source, destination, 0x2)  # Darwin RENAME_SWAP.


def present(path):
    return path.exists() or path.is_symlink()


def safe_path(path, home):
    path = Path(os.path.abspath(path))
    if not path.is_relative_to(home):
        raise ManagementError('Managed paths must stay inside the selected Home')
    current = home
    if home.is_symlink() or not home.is_dir():
        raise ManagementError('The selected Home must be a real directory')
    for part in path.relative_to(home).parts:
        current /= part
        if current.is_symlink():
            raise ManagementError('Managed path contains an unowned symlink')
    return path


def file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if present(path) else None


def atomic_json(path, value, expected=None, *, check_expected=False):
    if path.is_symlink():
        raise ManagementError('Metadata path is a symlink')
    if check_expected and file_digest(path) != expected:
        raise ManagementError('Metadata changed concurrently; inspect before retrying')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    try:
        with temp.open('x', encoding='utf8') as stream:
            os.chmod(temp, 0o600)
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        if check_expected and file_digest(path) != expected:
            raise ManagementError('Metadata changed concurrently; original preserved')
        os.replace(temp, path)
    finally:
        if present(temp):
            temp.unlink()
