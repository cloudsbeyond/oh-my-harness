"""Run with OMH_SKILL_NATIVE_TESTS=1; each phase starts a fresh client process."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from skill_source_management.core import Manager
from native_clients import claude_request, codex_skills


@unittest.skipUnless(os.environ.get('OMH_SKILL_NATIVE_TESTS') == '1' and sys.platform == 'darwin',
                     'Opt-in macOS native fixtures; no real provider accounts')
class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='omh-skill-native-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'home'
        self.cwd = self.root / 'work'
        self.home.mkdir()
        self.cwd.mkdir()
        self.manager = Manager(self.home)
        self.first = self.stage('v1')

    def stage(self, version):
        package = self.root / version / 'omh-native-fixture'
        package.mkdir(parents=True)
        (package / 'SKILL.md').write_text('---\nname: omh-native-fixture\n'
            f'description: OMH-NATIVE-{version} harmless lifecycle fixture\n---\n'
            f'OMH-BODY-{version}-ONLY. Reply with fixture-ok. Do not use any tools.\n')
        return self.manager.stage(package, origin='omh/native-fixture', ref=version)

    def test_codex_discovers_central_source_after_update_rollback_and_withdrawal(self):
        executable = os.environ.get('OMH_CODEX_BIN') or shutil.which('codex')
        if not executable:
            self.skipTest('Codex is not on PATH; optionally set OMH_CODEX_BIN')
        def visible(version=None):
            rows = [skill for skill in codex_skills(executable, self.home, self.cwd) if skill['name'] == 'omh-native-fixture']
            if version is None:
                self.assertEqual(rows, [])
            else:
                self.assertEqual(len(rows), 1)
                self.assertTrue(rows[0]['enabled'])
                self.assertIn('OMH-NATIVE-' + version, rows[0]['description'])
                self.assertEqual(Path(rows[0]['path']).resolve(), self.home / '.agents/skills/omh-native-fixture/SKILL.md')
        visible()
        self.manager.install(self.first['stage'], self.first['fingerprint'])
        self.manager.bind('omh-native-fixture', 'codex', self.first['fingerprint'])
        visible('v1')
        second = self.stage('v2')
        update = self.manager.update(second['stage'], second['fingerprint'], self.first['fingerprint'])
        visible('v2')
        self.manager.rollback(update['receipt'])
        visible('v1')
        unbound = self.manager.unbind('omh-native-fixture', 'codex')
        self.assertTrue(unbound['discovery_still_active'])
        visible('v1')
        self.manager.uninstall('omh-native-fixture', self.first['fingerprint'])
        visible()

    def test_claude_expands_actual_shared_body_after_update_rollback_and_unbind(self):
        executable = os.environ.get('OMH_CLAUDE_BIN') or shutil.which('claude')
        if not executable:
            self.skipTest('Claude Code is not on PATH; optionally set OMH_CLAUDE_BIN')
        self.manager.install(self.first['stage'], self.first['fingerprint'])
        self.manager.bind('omh-native-fixture', 'claude-code', self.first['fingerprint'])
        def loaded(version=None):
            requests, output = claude_request(executable, self.home, self.cwd, '/omh-native-fixture')
            body = json.dumps(requests)
            if version:
                self.assertTrue(requests, output)
                self.assertIn('OMH-BODY-' + version + '-ONLY', body)
                self.assertNotIn('OMH-BODY-' + ('v2' if version == 'v1' else 'v1') + '-ONLY', body)
                self.assertIn('fixture-ok', output)
            else:
                self.assertNotIn('OMH-BODY-', body)
        loaded('v1')
        second = self.stage('v2')
        update = self.manager.update(second['stage'], second['fingerprint'], self.first['fingerprint'])
        loaded('v2')
        self.manager.rollback(update['receipt'])
        loaded('v1')
        self.manager.unbind('omh-native-fixture', 'claude-code')
        loaded()
