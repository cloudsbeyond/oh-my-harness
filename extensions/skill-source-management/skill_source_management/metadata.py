"""Validate owned records before any record is allowed to select a filesystem target."""
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

from .clients import ROOTS, view
from .errors import ManagementError
from .packages import valid_name


def operation_id(value):
    return value is None or isinstance(value, str) and bool(re.fullmatch('[a-f0-9]{32}', value))


def origin_label(value):
    if not isinstance(value, str) or not value.strip() or '\n' in value or value.startswith(('/', '~')):
        raise ManagementError('Origin must be a source label, not a private local path')
    url = urlsplit(value)
    if url.scheme and (url.scheme == 'file' or url.username or url.password or url.query or url.fragment):
        raise ManagementError('Origin must not embed credentials, local paths or query data')


def source_record(name, record):
    fields = {'origin', 'ref', 'versions', 'license', 'fingerprint', 'declared_name'}
    if (not valid_name(name) or not isinstance(record, dict) or set(record) != fields or
            record['declared_name'] != name or not isinstance(record['fingerprint'], str) or
            not re.fullmatch('[a-f0-9]{64}', record['fingerprint']) or
            not isinstance(record['versions'], dict) or
            not all(isinstance(k, str) and isinstance(v, str) for k, v in record['versions'].items()) or
            any(record[k] is not None and not isinstance(record[k], str) for k in ['ref', 'license'])):
        raise ManagementError('Invalid owned source record; original preserved')
    origin_label(record['origin'])


def binding_record(home, sources, key, record):
    if not isinstance(record, dict) or not valid_name(record.get('name')):
        raise ManagementError('Invalid client binding metadata')
    expected = view(home, sources, record.get('client'), record['name'])
    if expected['mode'] == 'symlink':
        expected['target'] = os.path.relpath(sources / record['name'], Path(expected['path']).parent)
    if record != expected or key != expected['client'] + '/' + expected['name']:
        raise ManagementError('Binding metadata points outside its declared client view')


def history(records, bindings=False):
    for key, value in records.items():
        parts = key.split('/')
        valid = (len(parts) == 2 and parts[0] in ROOTS and valid_name(parts[1])) if bindings else valid_name(key)
        if not valid or not operation_id(value):
            raise ManagementError('Invalid operation ownership history; original preserved')
