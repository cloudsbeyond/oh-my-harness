import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from skill_source_management.core import Manager, ManagementError
from skill_source_management.packages import inspect_package

@unittest.skipUnless(sys.platform == "darwin", "Guarded lifecycle writes require macOS")
class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='omh-skill-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'home'
        self.home.mkdir()
        self.manager = Manager(self.home)
        self.candidate = self.make_skill('v1')

    def make_skill(self, version, extra=''):
        path = self.root / version / 'fixture-skill'
        path.mkdir(parents=True)
        (path / 'SKILL.md').write_text(
            '---\nname: fixture-skill\ndescription: Skill lifecycle fixture\n'
            f'metadata:\n  version: "{version}"\nlicense: MIT\n---\n'
            f'FIXTURE-{version}\n{extra}', encoding='utf8')
        (path / 'references').mkdir()
        (path / 'references' / 'detail.md').write_text(version)
        (path / 'scripts').mkdir()
        executable = path / 'scripts' / 'never-run.sh'
        executable.write_text('#!/bin/sh\nexit 77\n')
        executable.chmod(0o755)
        (path / 'reference-link').symlink_to('references/detail.md')
        return path

    def publish(self, source=None):
        stage = self.manager.stage(source or self.candidate, origin='example/skills', ref='v1')
        result = self.manager.install(stage['stage'], stage['fingerprint'])
        return stage, result

    def test_stage_does_not_publish_or_execute_candidate(self):
        stage = self.manager.stage(self.candidate)
        self.assertFalse((self.home / '.agents/skills/fixture-skill').exists())
        self.assertEqual(inspect_package(Path(stage['path']))['digest'], stage['fingerprint'])
        self.assertTrue((self.candidate / 'scripts/never-run.sh').is_file())

    def test_install_is_reviewed_and_idempotent(self):
        stage = self.manager.stage(self.candidate)
        with self.assertRaises(ManagementError):
            self.manager.install(stage['stage'], '0' * 64)
        result = self.manager.install(stage['stage'], stage['fingerprint'])
        self.assertEqual(self.manager.verify(result['receipt'])['status'], 'verified')
        again = self.manager.install(stage['stage'], stage['fingerprint'])
        self.assertEqual(again['status'], 'unchanged')
        registry = (self.home / '.agents/skills/.source-registry.json').read_text()
        self.assertNotIn(str(self.home), registry)
        self.assertNotIn(str(self.candidate), registry)

    def test_changed_stage_refuses_publication(self):
        stage = self.manager.stage(self.candidate)
        (Path(stage['path']) / 'SKILL.md').write_text('different')
        with self.assertRaises(ManagementError):
            self.manager.install(stage['stage'], stage['fingerprint'])
        self.assertFalse((self.home / '.agents/skills/fixture-skill').exists())

    def test_two_client_bindings_share_one_physical_source(self):
        stage, result = self.publish()
        codex = self.manager.bind('fixture-skill', 'codex', stage['fingerprint'])
        claude = self.manager.bind('fixture-skill', 'claude-code', stage['fingerprint'])
        self.assertEqual(codex['mode'], 'direct')
        self.assertFalse((self.home / '.codex/skills/fixture-skill').exists())
        entry = self.home / '.claude/skills/fixture-skill'
        self.assertTrue(entry.is_symlink())
        self.assertEqual(entry.resolve(), self.home / '.agents/skills/fixture-skill')
        self.assertEqual(self.manager.verify(claude['receipt'])['status'], 'verified')
        unbound = self.manager.unbind('fixture-skill', 'codex')
        self.assertTrue(unbound['discovery_still_active'])
        self.assertTrue((self.home / '.agents/skills/fixture-skill').exists())

    def test_foreign_native_entry_is_never_overwritten(self):
        stage, _ = self.publish()
        entry = self.home / '.claude/skills/fixture-skill'
        entry.mkdir(parents=True)
        (entry / 'SKILL.md').write_text('native owner')
        with self.assertRaises(ManagementError):
            self.manager.bind('fixture-skill', 'claude-code', stage['fingerprint'])
        self.assertEqual((entry / 'SKILL.md').read_text(), 'native owner')

    def test_codex_duplicate_legacy_entry_blocks_binding(self):
        stage, _ = self.publish()
        entry = self.home / '.codex/skills/fixture-skill'
        entry.mkdir(parents=True)
        with self.assertRaises(ManagementError):
            self.manager.bind('fixture-skill', 'codex', stage['fingerprint'])

    def test_update_requires_both_digests_and_keeps_link_readers_live(self):
        first, _ = self.publish()
        self.manager.bind('fixture-skill', 'claude-code', first['fingerprint'])
        second = self.manager.stage(self.make_skill('v2'))
        with self.assertRaises(ManagementError):
            self.manager.update(second['stage'], second['fingerprint'], '0' * 64)
        updated = self.manager.update(second['stage'], second['fingerprint'], first['fingerprint'])
        entry = self.home / '.claude/skills/fixture-skill/SKILL.md'
        self.assertIn('FIXTURE-v2', entry.read_text())
        self.assertEqual(self.manager.verify(updated['receipt'])['status'], 'verified')
        self.manager.rollback(updated['receipt'])
        self.assertIn('FIXTURE-v1', entry.read_text())

    def test_rollback_refuses_later_source_or_backup_edits(self):
        first, _ = self.publish()
        second = self.manager.stage(self.make_skill('v2'))
        updated = self.manager.update(second['stage'], second['fingerprint'], first['fingerprint'])
        source = self.home / '.agents/skills/fixture-skill/SKILL.md'
        source.write_text('later user work')
        with self.assertRaises(ManagementError):
            self.manager.rollback(updated['receipt'])
        self.assertEqual(source.read_text(), 'later user work')

    def test_link_drift_is_not_removed_by_unbind(self):
        stage, _ = self.publish()
        self.manager.bind('fixture-skill', 'claude-code', stage['fingerprint'])
        entry = self.home / '.claude/skills/fixture-skill'
        entry.unlink()
        entry.symlink_to(self.candidate)
        with self.assertRaises(ManagementError):
            self.manager.unbind('fixture-skill', 'claude-code')
        self.assertEqual(entry.resolve(), self.candidate)

    def test_unbind_and_uninstall_and_selective_rollback(self):
        stage, _ = self.publish()
        self.manager.bind('fixture-skill', 'codex', stage['fingerprint'])
        self.manager.bind('fixture-skill', 'claude-code', stage['fingerprint'])
        with self.assertRaises(ManagementError):
            self.manager.uninstall('fixture-skill', stage['fingerprint'])
        self.manager.unbind('fixture-skill', 'codex')
        unbind = self.manager.unbind('fixture-skill', 'claude-code')
        removed = self.manager.uninstall('fixture-skill', stage['fingerprint'])
        self.assertFalse((self.home / '.agents/skills/fixture-skill').exists())
        self.manager.rollback(removed['receipt'])
        self.manager.rollback(unbind['receipt'])
        self.assertTrue((self.home / '.claude/skills/fixture-skill').is_symlink())

    def test_install_rollback_refuses_bound_sources(self):
        stage, result = self.publish()
        self.manager.bind('fixture-skill', 'claude-code', stage['fingerprint'])
        with self.assertRaises(ManagementError):
            self.manager.rollback(result['receipt'])
        self.manager.unbind('fixture-skill', 'claude-code')
        self.manager.rollback(result['receipt'])
        self.assertFalse((self.home / '.agents/skills/fixture-skill').exists())

    def test_legacy_registry_refuses_even_stage_without_writing_state(self):
        source = self.home / '.agents/skills'
        source.mkdir(parents=True)
        registry = source / '.source-registry.json'
        text = '{"format":"skill-source-registry-v1","sources":{}}'
        registry.write_text(text)
        with self.assertRaises(ManagementError):
            self.manager.stage(self.candidate)
        self.assertEqual(registry.read_text(), text)
        self.assertFalse((self.home / '.agents/skill-management').exists())

    def test_managed_path_symlink_is_refused(self):
        (self.home / '.agents').symlink_to(self.root)
        with self.assertRaises(ManagementError):
            self.manager.stage(self.candidate)
        self.assertFalse((self.root / 'skill-management').exists())

    def test_tampered_binding_state_cannot_move_a_different_home_link(self):
        stage, _ = self.publish()
        self.manager.bind('fixture-skill', 'claude-code', stage['fingerprint'])
        state = self.home / '.agents/skill-management/ownership.json'
        value = json.loads(state.read_text())
        binding = value['bindings']['claude-code/fixture-skill']
        unrelated = self.home / 'unrelated-link'
        unrelated.symlink_to(binding['target'])
        binding['path'] = str(unrelated)
        state.write_text(json.dumps(value))
        with self.assertRaises(ManagementError):
            self.manager.unbind('fixture-skill', 'claude-code')
        self.assertTrue(unrelated.is_symlink())

    def test_uninstall_restores_a_source_changed_between_check_and_move(self):
        from unittest.mock import patch
        import skill_source_management.core as core
        stage, _ = self.publish()
        source = self.home / '.agents/skills/fixture-skill'
        original = core.rename_no_replace
        changed = False
        def race(left, right):
            nonlocal changed
            if Path(left) == source and not changed:
                changed = True
                (source / 'SKILL.md').write_text('later user work')
            return original(left, right)
        with patch.object(core, 'rename_no_replace', side_effect=race):
            with self.assertRaises(ManagementError):
                self.manager.uninstall('fixture-skill', stage['fingerprint'])
        self.assertEqual((source / 'SKILL.md').read_text(), 'later user work')

    def test_known_published_interruption_is_readable_and_can_roll_back(self):
        from unittest.mock import patch
        import skill_source_management.core as core
        stage = self.manager.stage(self.candidate)
        original = core.atomic_json
        def fail_registry(path, *args, **kwargs):
            if Path(path) == self.manager.registry_path:
                raise OSError('simulated registry write interruption')
            return original(path, *args, **kwargs)
        with patch.object(core, 'atomic_json', side_effect=fail_registry):
            with self.assertRaises(ManagementError):
                self.manager.install(stage['stage'], stage['fingerprint'])
        receipt = next((self.home / '.agents/skill-management/receipts').glob('*/receipt.json'))
        self.assertEqual(self.manager.verify(receipt)['status'], 'interrupted')
        self.manager.rollback(receipt)
        self.assertFalse((self.home / '.agents/skills/fixture-skill').exists())

    def test_nested_skill_or_plugin_unit_requires_a_separate_adapter(self):
        nested = self.candidate / 'skills/embedded'
        nested.mkdir(parents=True)
        (nested / 'SKILL.md').write_text('embedded instruction')
        with self.assertRaises(ManagementError):
            inspect_package(self.candidate)
        (nested / 'SKILL.md').unlink()
        (self.candidate / '.claude-plugin').mkdir()
        with self.assertRaises(ManagementError):
            inspect_package(self.candidate)

    def test_tampered_unbind_receipt_cannot_restore_into_an_unrelated_path(self):
        stage, _ = self.publish()
        self.manager.bind('fixture-skill', 'claude-code', stage['fingerprint'])
        result = self.manager.unbind('fixture-skill', 'claude-code')
        path = Path(result['receipt'])
        value = json.loads(path.read_text())
        unrelated = self.home / 'unrelated-link'
        value['before']['path'] = str(unrelated)
        path.write_text(json.dumps(value))
        with self.assertRaises(ManagementError):
            self.manager.rollback(path)
        self.assertFalse(unrelated.is_symlink())

    def test_invalid_nested_metadata_is_refused_before_any_mutation(self):
        stage, _ = self.publish()
        state = self.manager.ownership_path
        data = json.loads(state.read_text())
        data['source_ops']['fixture-skill'] = '../../other'
        state.write_text(json.dumps(data))
        with self.assertRaises(ManagementError):
            self.manager.stage(self.make_skill('v2'))
        self.assertIn('FIXTURE-v1', (self.manager.sources / 'fixture-skill/SKILL.md').read_text())

    def test_reverse_publication_interruption_is_not_reported_complete(self):
        from unittest.mock import patch
        import skill_source_management.core as core
        _, installed = self.publish()
        original = core.atomic_json
        def fail_registry(path, *args, **kwargs):
            if Path(path) == self.manager.registry_path:
                raise OSError('simulated rollback metadata interruption')
            return original(path, *args, **kwargs)
        with patch.object(core, 'atomic_json', side_effect=fail_registry):
            with self.assertRaises((ManagementError, OSError)):
                self.manager.rollback(installed['receipt'])
        observed = self.manager.verify(installed['receipt'])
        self.assertEqual(observed['status'], 'interrupted')
        self.assertFalse(observed['facts']['source']['present'])
        self.assertTrue(observed['facts']['reverted']['present'])
        with self.assertRaises(ManagementError):
            self.manager.rollback(installed['receipt'])

    def test_verified_unbind_requires_the_native_entry_to_remain_absent(self):
        stage, _ = self.publish()
        self.manager.bind('fixture-skill', 'claude-code', stage['fingerprint'])
        result = self.manager.unbind('fixture-skill', 'claude-code')
        native = self.home / '.claude/skills/fixture-skill'
        native.mkdir()
        with self.assertRaises(ManagementError):
            self.manager.verify(result['receipt'])
        self.assertTrue(native.is_dir())

    def test_audit_lists_unmanaged_sources_and_entries_without_adopting_them(self):
        self.publish()
        source = self.manager.sources / 'unmanaged-skill'
        source.mkdir()
        native = self.home / '.claude/skills/foreign-skill'
        native.mkdir(parents=True)
        observed = self.manager.audit()
        self.assertIn(str(source), observed['unmanaged_sources'])
        self.assertIn(str(native), observed['unmanaged_entries'])
        self.assertTrue(source.is_dir())
        self.assertTrue(native.is_dir())

    def test_changed_backup_refuses_rollback_and_preserves_current_source(self):
        first, _ = self.publish()
        second = self.manager.stage(self.make_skill('v2'))
        updated = self.manager.update(second['stage'], second['fingerprint'], first['fingerprint'])
        backup = Path(updated['receipt']).parent / 'original/fixture-skill/SKILL.md'
        backup.write_text('later backup edit')
        with self.assertRaises(ManagementError):
            self.manager.rollback(updated['receipt'])
        self.assertIn('FIXTURE-v2', (self.manager.sources / 'fixture-skill/SKILL.md').read_text())
        self.assertEqual(backup.read_text(), 'later backup edit')

    def test_selective_rollback_preserves_unrelated_later_installation(self):
        _, first = self.publish()
        other = self.root / 'other/another-skill'
        other.mkdir(parents=True)
        (other / 'SKILL.md').write_text('---\nname: another-skill\ndescription: Another fixture\n---\nKEEP-ME\n')
        staged = self.manager.stage(other)
        installed = self.manager.install(staged['stage'], staged['fingerprint'])
        self.manager.rollback(first['receipt'])
        self.assertEqual(self.manager.verify(installed['receipt'])['status'], 'verified')
        self.assertIn('KEEP-ME', (self.manager.sources / 'another-skill/SKILL.md').read_text())

    def test_concurrent_installers_converge_without_duplicate_publication(self):
        import subprocess
        stage = self.manager.stage(self.candidate)
        script = ("import json,sys; from skill_source_management.core import Manager; "
                  "print(json.dumps(Manager(sys.argv[1]).install(sys.argv[2],sys.argv[3])))")
        env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1])}
        command = [sys.executable, '-B', '-c', script, str(self.home), stage['stage'], stage['fingerprint']]
        processes = [subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        outcomes = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stderr)
            outcomes.append(json.loads(stdout)['status'])
        self.assertEqual(sorted(outcomes), ['applied', 'unchanged'])
        self.assertEqual(len(list((self.manager.state / 'receipts').glob('*/receipt.json'))), 1)
        self.assertEqual(self.manager.audit()['status'], 'verified')

    def test_corrupt_stage_metadata_is_refused_as_a_management_error(self):
        stage = self.manager.stage(self.candidate)
        path = self.manager.state / 'staging' / stage['stage'] / 'stage.json'
        info = json.loads(path.read_text())
        del info['versions']
        path.write_text(json.dumps(info))
        with self.assertRaises(ManagementError):
            self.manager.install(stage['stage'], stage['fingerprint'])
        self.assertFalse((self.manager.sources / 'fixture-skill').exists())

    def test_partial_ownership_write_blocks_retry_until_guarded_rollback(self):
        from unittest.mock import patch
        import skill_source_management.core as core
        stage = self.manager.stage(self.candidate)
        original = core.atomic_json
        def fail_ownership(path, *args, **kwargs):
            if Path(path) == self.manager.ownership_path:
                raise OSError('simulated ownership write interruption')
            return original(path, *args, **kwargs)
        with patch.object(core, 'atomic_json', side_effect=fail_ownership):
            with self.assertRaises(ManagementError):
                self.manager.install(stage['stage'], stage['fingerprint'])
        receipt = next((self.manager.state / 'receipts').glob('*/receipt.json'))
        self.assertEqual(self.manager.verify(receipt)['status'], 'interrupted')
        with self.assertRaises(ManagementError):
            self.manager.install(stage['stage'], stage['fingerprint'])
        with self.assertRaises(ManagementError):
            self.manager.bind('fixture-skill', 'codex', stage['fingerprint'])
        self.assertNotEqual(self.manager.audit()['status'], 'verified')
        self.manager.rollback(receipt)
        result = self.manager.install(stage['stage'], stage['fingerprint'])
        self.assertEqual(self.manager.verify(result['receipt'])['status'], 'verified')

    def test_uninspectable_concurrent_edit_is_restored_after_update_exchange(self):
        from unittest.mock import patch
        import skill_source_management.core as core
        first, _ = self.publish()
        second = self.manager.stage(self.make_skill('v2'))
        source = self.manager.sources / 'fixture-skill'
        original = core.exchange
        mutated = False
        def race(left, right):
            nonlocal mutated
            if Path(right) == source and not mutated:
                mutated = True
                (source / 'SKILL.md').write_text('UNPARSEABLE LATER USER EDIT')
            return original(left, right)
        with patch.object(core, 'exchange', side_effect=race):
            with self.assertRaises(ManagementError):
                self.manager.update(second['stage'], second['fingerprint'], first['fingerprint'])
        self.assertEqual((source / 'SKILL.md').read_text(), 'UNPARSEABLE LATER USER EDIT')
        incoming = next((self.manager.state / 'receipts').glob('*/incoming/fixture-skill/SKILL.md'))
        self.assertIn('FIXTURE-v2', incoming.read_text())

    def test_withdrawal_refuses_differently_named_foreign_consumers(self):
        stage, installed = self.publish()
        source = self.manager.sources / 'fixture-skill'
        for client in ['.codex', '.claude']:
            alias = self.home / client / 'skills/foreign-alias'
            alias.parent.mkdir(parents=True, exist_ok=True)
            alias.symlink_to(source)
            with self.subTest(client=client):
                with self.assertRaises(ManagementError):
                    self.manager.uninstall('fixture-skill', stage['fingerprint'])
                with self.assertRaises(ManagementError):
                    self.manager.rollback(installed['receipt'])
                self.assertEqual(alias.resolve(), source)
                self.assertTrue(source.is_dir())
            alias.unlink()

    def test_custom_roots_cannot_overlap_native_discovery_before_any_write(self):
        for client in ['.codex', '.claude']:
            native = self.home / client / 'skills/foreign-skill'
            native.mkdir(parents=True)
            (native / 'SKILL.md').write_text('foreign content')
            for argument in ['state_root', 'source_root']:
                with self.subTest(client=client, argument=argument):
                    with self.assertRaises(ManagementError):
                        manager = Manager(self.home, **{argument: native})
                        manager.stage(self.candidate)
                    self.assertEqual(list(native.iterdir()), [native / 'SKILL.md'])
                    self.assertFalse((self.manager.state / 'manager.lock').exists())

    def test_metadata_guard_preserves_edit_between_parse_and_fingerprint(self):
        from unittest.mock import patch
        import inspect
        import skill_source_management.core as core
        first, _ = self.publish()
        other = self.root / 'other/another-skill'
        other.mkdir(parents=True)
        (other / 'SKILL.md').write_text('---\nname: another-skill\ndescription: Other fixture\n---\n')
        stage = self.manager.stage(other)
        self.manager.install(stage['stage'], stage['fingerprint'])
        second = self.manager.stage(self.make_skill('v2'))
        original = core.json.loads
        mutated = False
        def concurrent_edit(text, *args, **kwargs):
            nonlocal mutated
            value = original(text, *args, **kwargs)
            if (not mutated and isinstance(value, dict) and 'sources' in value and
                    [frame.function for frame in inspect.stack() if frame.filename == core.__file__][:3] == ['_read', '_load', '_publish']):
                mutated = True
                updated = original(text)
                updated['sources']['another-skill']['ref'] = 'later-user-edit'
                self.manager.registry_path.write_text(json.dumps(updated))
            return value
        with patch.object(core.json, 'loads', side_effect=concurrent_edit):
            with self.assertRaises(ManagementError):
                self.manager.update(second['stage'], second['fingerprint'], first['fingerprint'])
        registry = json.loads(self.manager.registry_path.read_text())
        self.assertEqual(registry['sources']['another-skill']['ref'], 'later-user-edit')
        self.assertIn('FIXTURE-v1', (self.manager.sources / 'fixture-skill/SKILL.md').read_text())


if __name__ == '__main__':
    unittest.main()
