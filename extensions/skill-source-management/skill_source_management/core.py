"""Owned local lifecycle. Source facts and private operation state stay separate."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import re
import time
import uuid

from .clients import ROOTS, view
from .errors import ManagementError
from .filesystem import atomic_json, exchange, file_digest, present, rename_no_replace, require_supported, safe_path
from .packages import copy_package, inspect_package, valid_name
from .metadata import binding_record, history, operation_id, origin_label, source_record

SOURCE_FORMAT = 'omh-skill-sources-v1'
STATE_FORMAT = 'omh-skill-state-v1'
RECEIPT_FORMAT = 'omh-skill-operation-v1'


class Manager:
    def __init__(self, home, source_root=None, state_root=None):
        selected = Path(home).expanduser().absolute()
        if selected.is_symlink() or not selected.is_dir():
            raise ManagementError('Select an existing, real Home directory')
        self.home = selected.resolve()
        self.sources = Path(source_root).expanduser().absolute() if source_root else self.home / '.agents/skills'
        self.state = Path(state_root).expanduser().absolute() if state_root else self.home / '.agents/skill-management'
        if self.sources == self.state or self.sources.is_relative_to(self.state) or self.state.is_relative_to(self.sources):
            raise ManagementError('Source and private state roots must not overlap')
        self.registry_path = self.sources / '.source-registry.json'
        self.ownership_path = self.state / 'ownership.json'
        for path in [self.sources, self.state]:
            safe_path(path, self.home)
            for folder in ROOTS.values():
                native = self.home / folder
                if path == native or path.is_relative_to(native) or native.is_relative_to(path):
                    raise ManagementError('Accepted source and private state must stay outside native discovery roots')

    def _read(self, path, format_name, empty):
        safe_path(path, self.home)
        if not present(path):
            return {'format': format_name, **deepcopy(empty)}, None
        if not path.is_file():
            raise ManagementError('Owned metadata is not a regular file')
        try:
            snapshot = path.read_bytes()
            value = json.loads(snapshot.decode('utf8'))
        except (ValueError, UnicodeError) as error:
            raise ManagementError('Invalid owned metadata; original preserved') from error
        if not isinstance(value, dict) or value.get('format') != format_name or any(not isinstance(value.get(k), type(v)) for k, v in empty.items()):
            raise ManagementError('Legacy or foreign registry requires an explicit migration; original preserved')
        return value, hashlib.sha256(snapshot).hexdigest()

    def _load(self):
        registry, registry_hash = self._read(self.registry_path, SOURCE_FORMAT, {'sources': {}})
        ownership, ownership_hash = self._read(self.ownership_path, STATE_FORMAT,
                                              {'bindings': {}, 'source_ops': {}, 'binding_ops': {}})
        for name, record in registry['sources'].items():
            source_record(name, record)
        for key, record in ownership['bindings'].items():
            binding_record(self.home, self.sources, key, record)
        history(ownership['source_ops'])
        history(ownership['binding_ops'], bindings=True)
        return registry, registry_hash, ownership, ownership_hash

    @contextmanager
    def _locked(self):
        require_supported()
        import fcntl
        self._load()  # Reject foreign state before creating a lock or any new directories.
        safe_path(self.state, self.home)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = self.state / 'manager.lock'
        safe_path(lock, self.home)
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ManagementError('Source manager is busy; read back before retrying')
                    time.sleep(0.05)
            self._load()
            yield
        finally:
            os.close(fd)

    def _source(self, name):
        if not valid_name(name):
            raise ManagementError('Expected one lowercase standalone Skill name')
        return safe_path(self.sources / name, self.home)

    def _owned(self, name, expected=None):
        registry, _, _, _ = self._load()
        entry = registry['sources'].get(name)
        if not entry:
            raise ManagementError('Source is not owned by this manager')
        actual = inspect_package(self._source(name))['digest']
        if actual != entry['fingerprint'] or (expected is not None and expected != actual):
            raise ManagementError('Canonical source drifted; review its current digest')
        return entry

    def _new_receipt(self, operation, name, before, after, **details):
        receipt_id = uuid.uuid4().hex
        path = self.state / 'receipts' / receipt_id / 'receipt.json'
        safe_path(path, self.home)
        value = {'format': RECEIPT_FORMAT, 'id': receipt_id, 'home': str(self.home),
                 'source_root': str(self.sources), 'state_root': str(self.state),
                 'operation': operation, 'name': name, 'before': before, 'after': after,
                 'status': 'preparing', 'created_at': datetime.now(timezone.utc).isoformat(), **details}
        atomic_json(path, value)
        return path, value

    def _save(self, path, receipt, status):
        receipt['status'] = status
        atomic_json(path, receipt)

    def _receipt(self, value):
        path = Path(value).expanduser().absolute()
        safe_path(path, self.home)
        if not path.is_relative_to(self.state / 'receipts') or path.parent.parent != self.state / 'receipts' or path.name != 'receipt.json' or not re.fullmatch('[a-f0-9]{32}', path.parent.name):
            raise ManagementError('Receipt must belong to this manager state directory')
        try:
            receipt = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            raise ManagementError('Receipt is missing or invalid') from error
        if (not isinstance(receipt, dict) or receipt.get('format') != RECEIPT_FORMAT or receipt.get('id') != path.parent.name or
                any(receipt.get(k) != str(v) for k, v in [('home', self.home), ('source_root', self.sources), ('state_root', self.state)])):
            raise ManagementError('Receipt scope does not match this manager')
        name, op = receipt.get('name'), receipt.get('operation')
        self._source(name)
        shapes = {'install': (False, True), 'update': (True, True), 'uninstall': (True, False),
                  'bind': (False, True), 'unbind': (True, False)}
        if (not isinstance(op, str) or op not in shapes or not operation_id(receipt.get('previous_op')) or
                receipt.get('status') not in ['preparing', 'publishing', 'published', 'complete',
                                              'reversing', 'reversed', 'rolled_back']):
            raise ManagementError('Invalid operation receipt')
        for field, required in zip(['before', 'after'], shapes[op]):
            value = receipt.get(field)
            if not required:
                if value is not None:
                    raise ManagementError('Invalid receipt before/after shape')
            elif op in ['bind', 'unbind']:
                binding_record(self.home, self.sources, receipt.get('key'), value)
                if value['name'] != name:
                    raise ManagementError('Receipt name and client binding differ')
            else:
                source_record(name, value)
        if op not in ['bind', 'unbind'] and 'key' in receipt:
            raise ManagementError('Source receipt cannot select a binding history')
        return path, receipt

    def _interrupted(self, name=None, exclude=None):
        root = safe_path(self.state / 'receipts', self.home)
        if not present(root):
            return []
        if not root.is_dir():
            raise ManagementError('Receipt root is not a directory')
        pending = []
        for target in sorted(root.glob('*/receipt.json')):
            path, receipt = self._receipt(target)
            if (receipt['id'] != exclude and (name is None or receipt['name'] == name) and
                    receipt['status'] not in ['complete', 'rolled_back']):
                pending.append({'name': receipt['name'], 'operation': receipt['operation'],
                                'phase': receipt['status'], 'receipt': str(path)})
        return pending

    def _require_reconciled(self, name, exclude=None):
        pending = self._interrupted(name, exclude)
        if pending:
            raise ManagementError(f'Target has an interrupted operation; inspect before retrying: {pending[0]["receipt"]}')

    def _result(self, receipt_path, receipt, **extra):
        return {'status': 'applied', 'operation': receipt['operation'], 'name': receipt['name'],
                'receipt': str(receipt_path), **extra}

    def stage(self, source, origin='local', ref=None):
        source = Path(source).expanduser().absolute()
        for root in [self.sources, self.state, *(self.home / p for p in ROOTS.values())]:
            if source == root or source.is_relative_to(root) or root.is_relative_to(source):
                raise ManagementError('Stage from outside managed source/state and native discovery roots')
        origin_label(origin)
        if ref is not None and not isinstance(ref, str):
            raise ManagementError('Ref must be explicit text evidence')
        with self._locked():
            package = inspect_package(source)
            stage_id = uuid.uuid4().hex
            folder = self.state / 'staging' / stage_id
            target = folder / package['name']
            safe_path(target, self.home)
            copy_package(source, target, package['digest'])
            info = {'format': 'omh-skill-stage-v1', 'name': package['name'], 'fingerprint': package['digest'],
                    'origin': origin, 'ref': ref, 'versions': package['versions'], 'license': package['license']}
            atomic_json(folder / 'stage.json', info)
            return {'status': 'staged', 'stage': stage_id, 'path': str(target), 'fingerprint': package['digest'],
                    'package_code_executed': False}

    def _stage(self, stage_id, expected):
        if not re.fullmatch('[a-f0-9]{32}', stage_id):
            raise ManagementError('Invalid staging identity')
        folder = safe_path(self.state / 'staging' / stage_id, self.home)
        safe_path(folder / 'stage.json', self.home)
        try:
            info = json.loads((folder / 'stage.json').read_text())
        except (OSError, ValueError) as error:
            raise ManagementError('Stage metadata is missing or invalid') from error
        if not isinstance(info, dict) or not valid_name(info.get('name')) or info.get('format') != 'omh-skill-stage-v1' or info.get('fingerprint') != expected:
            raise ManagementError('Reviewed candidate digest does not match its stage')
        source_record(info['name'], {**{k: info.get(k) for k in ['origin', 'ref', 'versions', 'license', 'fingerprint']}, 'declared_name': info['name']})
        path = safe_path(folder / info['name'], self.home)
        if inspect_package(path)['digest'] != expected:
            raise ManagementError('Staged candidate changed; review before publication')
        return info, path

    def install(self, stage_id, expect_source):
        return self._publish(stage_id, expect_source, None, False)

    def update(self, stage_id, expect_source, expect_current):
        return self._publish(stage_id, expect_source, expect_current, True)

    def _publish(self, stage_id, expect_source, expect_current, update):
        with self._locked():
            info, staged = self._stage(stage_id, expect_source)
            name = info['name']
            self._require_reconciled(name)
            destination = self._source(name)
            registry, rh, ownership, oh = self._load()
            before = registry['sources'].get(name)
            if update:
                if expect_current is None:
                    raise ManagementError('Update requires the reviewed current digest')
                self._owned(name, expect_current)
            elif before:
                self._owned(name)
                if before['fingerprint'] == expect_source:
                    return {'status': 'unchanged', 'name': name, 'fingerprint': expect_source}
                raise ManagementError('Source is occupied; use update with both reviewed digests')
            elif present(destination):
                raise ManagementError('Unowned source destination is occupied')
            after = {k: info[k] for k in ['origin', 'ref', 'versions', 'license', 'fingerprint']}
            after['declared_name'] = name
            path, receipt = self._new_receipt('update' if update else 'install', name, before, after,
                                               previous_op=ownership['source_ops'].get(name))
            incoming = path.parent / 'incoming' / name
            original = path.parent / 'original' / name
            try:
                copy_package(staged, incoming, expect_source)
                safe_path(destination.parent, self.home).mkdir(parents=True, exist_ok=True, mode=0o700)
                if file_digest(self.registry_path) != rh:
                    raise ManagementError('Registry changed during publication')
                self._save(path, receipt, 'publishing')
                if update:
                    self._owned(name, expect_current)
                    exchange(incoming, destination)
                    try:
                        matches = (inspect_package(incoming)['digest'] == expect_current and
                                   inspect_package(destination)['digest'] == expect_source)
                    except (ManagementError, OSError):
                        matches = False
                    if not matches:
                        exchange(incoming, destination)
                        raise ManagementError('Concurrent source edit detected; restored original')
                    original.parent.mkdir(mode=0o700)
                    rename_no_replace(incoming, original)
                else:
                    rename_no_replace(incoming, destination)
                self._save(path, receipt, 'published')
                registry['sources'][name] = after
                atomic_json(self.registry_path, registry, rh, check_expected=True)
                ownership['source_ops'][name] = receipt['id']
                atomic_json(self.ownership_path, ownership, oh, check_expected=True)
                self._save(path, receipt, 'complete')
            except Exception as error:
                raise ManagementError(f'Publication not confirmed; inspect receipt {path}: {error}') from error
            return self._result(path, receipt, fingerprint=expect_source, package_code_executed=False,
                                direct_discovery_may_expand=self.sources == self.home / '.agents/skills')

    def _binding_ok(self, binding):
        key = binding.get('client', '') + '/' + binding.get('name', '') if isinstance(binding, dict) else ''
        binding_record(self.home, self.sources, key, binding)
        self._owned(binding['name'])
        native = Path(binding['path'])
        safe_path(native.parent, self.home)
        if binding['mode'] == 'direct':
            if present(native):
                raise ManagementError('Duplicate legacy Codex entry must be resolved explicitly')
        elif not native.is_symlink() or os.readlink(native) != binding['target']:
            raise ManagementError('Owned client entry changed; original preserved')

    def bind(self, name, client, expect_current):
        with self._locked():
            self._owned(name, expect_current)
            self._require_reconciled(name)
            binding = view(self.home, self.sources, client, name)
            native = Path(binding['path'])
            safe_path(native.parent, self.home)
            registry, rh, ownership, oh = self._load()
            key = client + '/' + name
            current = ownership['bindings'].get(key)
            if current:
                self._binding_ok(current)
                return {'status': 'unchanged', 'mode': current['mode'], 'name': name}
            if present(native):
                raise ManagementError('Native entry is unowned or duplicate; original preserved')
            if binding['mode'] == 'symlink':
                binding['target'] = os.path.relpath(self._source(name), native.parent)
            path, receipt = self._new_receipt('bind', name, None, binding, key=key,
                                               previous_op=ownership['binding_ops'].get(key))
            if binding['mode'] == 'symlink':
                native.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.symlink(binding['target'], native)
            self._save(path, receipt, 'published')
            ownership['bindings'][key] = binding
            ownership['binding_ops'][key] = receipt['id']
            atomic_json(self.ownership_path, ownership, oh, check_expected=True)
            self._save(path, receipt, 'complete')
            return self._result(path, receipt, mode=binding['mode'], path=binding['source_path'])

    def _move_entry(self, binding, backup):
        self._binding_ok(binding)
        if binding['mode'] == 'direct':
            return
        native = Path(binding['path'])
        rename_no_replace(native, backup)
        if not backup.is_symlink() or os.readlink(backup) != binding['target']:
            rename_no_replace(backup, native)
            raise ManagementError('Concurrent client entry edit detected; restored original')

    def unbind(self, name, client):
        with self._locked():
            view(self.home, self.sources, client, name)
            self._require_reconciled(name)
            registry, rh, ownership, oh = self._load()
            key = client + '/' + name
            before = ownership['bindings'].get(key)
            if not before:
                return {'status': 'unchanged', 'name': name}
            self._binding_ok(before)
            path, receipt = self._new_receipt('unbind', name, before, None, key=key,
                                               previous_op=ownership['binding_ops'].get(key))
            self._move_entry(before, path.parent / 'entry')
            self._save(path, receipt, 'published')
            del ownership['bindings'][key]
            ownership['binding_ops'][key] = receipt['id']
            atomic_json(self.ownership_path, ownership, oh, check_expected=True)
            self._save(path, receipt, 'complete')
            return self._result(path, receipt, discovery_still_active=before['mode'] == 'direct')

    def _no_consumers(self, name):
        _, _, ownership, _ = self._load()
        if any(b['name'] == name for b in ownership['bindings'].values()):
            raise ManagementError('Unbind owned clients before withdrawing the source')
        destination = self._source(name)
        for folder in ROOTS.values():
            root = safe_path(self.home / folder, self.home)
            if not root.is_dir():
                continue
            for entry in root.iterdir():
                if entry.is_symlink():
                    try:
                        target = entry.resolve()
                    except (OSError, RuntimeError) as error:
                        raise ManagementError('Cannot resolve a native consumer; preserve source') from error
                    if target == destination or target.is_relative_to(destination):
                        raise ManagementError('A native link still consumes this source')

    def _move_package(self, source, backup, expected):
        rename_no_replace(source, backup)
        try:
            matches = inspect_package(backup)['digest'] == expected
        except (ManagementError, OSError):
            matches = False
        if not matches:
            try:
                rename_no_replace(backup, source)
            except OSError as error:
                raise ManagementError('Changed package retained in receipt backup; source slot is occupied') from error
            raise ManagementError('Concurrent package edit detected; restored original')

    def uninstall(self, name, expect_current):
        with self._locked():
            before = self._owned(name, expect_current)
            self._require_reconciled(name)
            self._no_consumers(name)
            registry, rh, ownership, oh = self._load()
            path, receipt = self._new_receipt('uninstall', name, before, None,
                                               previous_op=ownership['source_ops'].get(name))
            original = path.parent / 'original' / name
            original.parent.mkdir(mode=0o700)
            self._move_package(self._source(name), original, expect_current)
            self._save(path, receipt, 'published')
            del registry['sources'][name]
            atomic_json(self.registry_path, registry, rh, check_expected=True)
            ownership['source_ops'][name] = receipt['id']
            atomic_json(self.ownership_path, ownership, oh, check_expected=True)
            self._save(path, receipt, 'complete')
            return self._result(path, receipt, source_retained_in_backup=True)

    def verify(self, receipt_path):
        path, receipt = self._receipt(receipt_path)
        registry, _, ownership, _ = self._load()
        name, operation = receipt['name'], receipt['operation']
        if receipt['status'] not in ['complete', 'rolled_back']:
            return {'status': 'interrupted', 'phase': receipt['status'], 'receipt': str(path),
                    'facts': self._facts(path, receipt, registry, ownership),
                    'note': 'Inspect retained payloads; only published supports guarded rollback. Other phases require manual reconciliation'}
        self._require_reconciled(name, exclude=receipt['id'])
        rolled = receipt['status'] == 'rolled_back'
        expected = receipt['before'] if rolled else receipt['after']
        if operation in ['bind', 'unbind']:
            if ownership['bindings'].get(receipt['key']) != expected:
                raise ManagementError('Binding has later changes')
            if expected:
                self._binding_ok(expected)
            else:
                binding = receipt['before'] or receipt['after']
                native = Path(binding['path'])
                safe_path(native.parent, self.home)
                if present(native):
                    raise ManagementError('An unowned client entry appeared')
                if not rolled and binding['mode'] == 'symlink':
                    backup = path.parent / 'entry'
                    if not backup.is_symlink() or os.readlink(backup) != binding['target']:
                        raise ManagementError('Original client link changed')
        else:
            if registry['sources'].get(name) != expected:
                raise ManagementError('Source registry has later changes')
            if expected:
                self._owned(name, expected['fingerprint'])
            elif present(self._source(name)):
                raise ManagementError('An unowned source appeared')
            if not rolled and receipt['before']:
                backup = path.parent / 'original' / name
                if inspect_package(backup)['digest'] != receipt['before']['fingerprint']:
                    raise ManagementError('Original source backup changed')
        return {'status': 'verified', 'operation': operation, 'receipt': str(path)}

    def _facts(self, path, receipt, registry, ownership):
        def package(target):
            safe_path(target, self.home)
            result = {'present': present(target)}
            if result['present']:
                try:
                    result['fingerprint'] = inspect_package(target)['digest']
                except (ManagementError, OSError) as error:
                    result['error'] = str(error)
            return result
        name = receipt['name']
        facts = {label: package(target) for label, target in [
            ('source', self._source(name)), ('original', path.parent / 'original' / name),
            ('incoming', path.parent / 'incoming' / name), ('reverted', path.parent / 'reverted' / name)]}
        facts['registry'] = registry['sources'].get(name)
        if receipt['operation'] in ['bind', 'unbind']:
            binding = receipt['before'] or receipt['after']
            native = Path(binding['path'])
            safe_path(native.parent, self.home)
            facts['native'] = {'present': present(native), 'target': os.readlink(native) if native.is_symlink() else None}
            facts['binding'] = ownership['bindings'].get(receipt['key'])
        return facts

    def rollback(self, receipt_path):
        with self._locked():
            path, receipt = self._receipt(receipt_path)
            if receipt['status'] == 'rolled_back':
                self.verify(path)
                return {'status': 'rolled_back', 'receipt': str(path)}
            if receipt['status'] not in ['complete', 'published']:
                raise ManagementError('This interrupted phase needs manual reconciliation; no blind recovery')
            registry, rh, ownership, oh = self._load()
            name, op = receipt['name'], receipt['operation']
            self._require_reconciled(name, exclude=receipt['id'])
            binding_op = op in ['bind', 'unbind']
            histories = ownership['binding_ops'] if binding_op else ownership['source_ops']
            key = receipt['key'] if binding_op else name
            if histories.get(key) not in [receipt['id'], receipt.get('previous_op')]:
                raise ManagementError('A later operation owns this target')
            if receipt['status'] == 'complete':
                self.verify(path)
            before, after = receipt['before'], receipt['after']
            if binding_op:
                if ownership['bindings'].get(key) not in [after, before]:
                    raise ManagementError('Binding has later edits')
                binding = after if op == 'bind' else before
                native = Path(binding['path'])
                safe_path(native.parent, self.home)
                if op == 'bind':
                    self._binding_ok(binding)
                else:
                    self._owned(name)
                    if present(native):
                        raise ManagementError('Client entry is now occupied')
                    backup = path.parent / 'entry'
                    if binding['mode'] == 'symlink' and (not backup.is_symlink() or os.readlink(backup) != binding['target']):
                        raise ManagementError('Original client link changed')
            else:
                destination = self._source(name)
                if registry['sources'].get(name) not in [before, after]:
                    raise ManagementError('Source registry has later edits')
                if after and inspect_package(destination)['digest'] != after['fingerprint']:
                    raise ManagementError('Source changed since publication')
                if op == 'install':
                    self._no_consumers(name)
                else:
                    original = safe_path(path.parent / 'original' / name, self.home)
                    if inspect_package(original)['digest'] != before['fingerprint']:
                        raise ManagementError('Original backup changed')
                    if op == 'uninstall' and present(destination):
                        raise ManagementError('Source destination is occupied')
            # Journal before reversal. An interrupted reverse operation is never replayed automatically.
            self._save(path, receipt, 'reversing')
            try:
                if binding_op:
                    if op == 'bind':
                        self._move_entry(binding, path.parent / 'reverted-entry')
                    elif binding['mode'] == 'symlink':
                        rename_no_replace(backup, native)
                    if before:
                        ownership['bindings'][key] = before
                    else:
                        ownership['bindings'].pop(key, None)
                else:
                    if op == 'install':
                        revert = path.parent / 'reverted' / name
                        safe_path(revert, self.home).parent.mkdir(mode=0o700)
                        self._move_package(destination, revert, after['fingerprint'])
                    elif op == 'update':
                        exchange(original, destination)
                        try:
                            matches = (inspect_package(original)['digest'] == after['fingerprint'] and
                                       inspect_package(destination)['digest'] == before['fingerprint'])
                        except (ManagementError, OSError):
                            matches = False
                        if not matches:
                            exchange(original, destination)
                            raise ManagementError('Concurrent source edit found; restored pre-reversal state')
                    else:
                        self._move_package(original, destination, before['fingerprint'])
                    if before:
                        registry['sources'][name] = before
                    else:
                        registry['sources'].pop(name, None)
                self._save(path, receipt, 'reversed')
                histories[key] = receipt.get('previous_op')
                if not binding_op:
                    atomic_json(self.registry_path, registry, rh, check_expected=True)
                atomic_json(self.ownership_path, ownership, oh, check_expected=True)
                self._save(path, receipt, 'rolled_back')
            except Exception as error:
                raise ManagementError(f'Rollback not confirmed; inspect receipt {path}: {error}') from error
            return {'status': 'rolled_back', 'receipt': str(path)}

    def audit(self):
        registry, _, ownership, _ = self._load()
        interrupted = self._interrupted()
        problems = [{'interrupted': value} for value in interrupted]
        for name in registry['sources']:
            try:
                self._owned(name)
            except (ManagementError, OSError) as error:
                problems.append({'source': name, 'error': str(error)})
        for key, binding in ownership['bindings'].items():
            try:
                self._binding_ok(binding)
            except (ManagementError, OSError) as error:
                problems.append({'binding': key, 'error': str(error)})
        unmanaged_sources = [str(p) for p in self.sources.iterdir() if not p.name.startswith('.') and p.name not in registry['sources']] if self.sources.is_dir() else []
        unmanaged_entries = []
        for client, folder in ROOTS.items():
            root = self.home / folder
            safe_path(root, self.home)
            if root.is_dir():
                unmanaged_entries.extend(str(p) for p in root.iterdir() if not p.name.startswith('.') and client + '/' + p.name not in ownership['bindings'])
        return {'status': 'verified' if not problems else 'drift', 'sources': sorted(registry['sources']),
                'coverage': 'Owned records plus visible entries in the selected roots, not whole-machine coverage',
                'unmanaged_sources': sorted(unmanaged_sources), 'unmanaged_entries': sorted(unmanaged_entries),
                'bindings': sorted(ownership['bindings']), 'interrupted': interrupted, 'problems': problems}
