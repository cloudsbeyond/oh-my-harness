"""Portable package checks; lifecycle mutation tests remain macOS-only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from skill_source_management.core import Manager, ManagementError
from skill_source_management.packages import inspect_package


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='omh-package-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.candidate = self.root / 'fixture-skill'
        self.candidate.mkdir()
        (self.candidate / 'SKILL.md').write_text(
            '---\nname: fixture-skill\ndescription: Readonly fixture\n'
            'metadata:\n  version: "v1"\nlicense: MIT\n---\nFixture body\n', encoding='utf8')
        (self.candidate / 'references').mkdir()
        (self.candidate / 'references/detail.md').write_text('detail', encoding='utf8')
        (self.candidate / 'scripts').mkdir()
        (self.candidate / 'scripts/never-run.sh').write_text('#!/bin/sh\nexit 77\n', encoding='utf8')
        (self.candidate / 'scripts/never-run.sh').chmod(0o755)

    def test_full_fingerprint_includes_resources_modes_and_relative_links(self):
        if os.name != 'nt':
            (self.candidate / 'reference-link').symlink_to('references/detail.md')
        first = inspect_package(self.candidate)
        if os.name != 'nt':
            self.assertEqual(first['nodes']['reference-link']['target'], 'references/detail.md')
        self.assertEqual(first['name'], 'fixture-skill')
        self.assertEqual(first['versions']['metadata.version'], 'v1')
        (self.candidate / 'references/detail.md').write_text('changed')
        second = inspect_package(self.candidate)
        self.assertNotEqual(first['digest'], second['digest'])
        if os.name != 'nt':
            (self.candidate / 'reference-link').unlink()
            (self.candidate / 'reference-link').symlink_to('scripts/never-run.sh')
            third = inspect_package(self.candidate)
            self.assertNotEqual(second['digest'], third['digest'])
            (self.candidate / 'scripts/never-run.sh').chmod(0o644)
            self.assertNotEqual(third['digest'], inspect_package(self.candidate)['digest'])

    def test_rejects_escaping_symlinks_runtime_and_credential_payloads(self):
        outside = self.root / 'outside'
        outside.write_text('private')
        if os.name != 'nt':
            (self.candidate / 'bad-link').symlink_to(outside)
            with self.assertRaises(ManagementError):
                inspect_package(self.candidate)
            (self.candidate / 'bad-link').unlink()
        for name in ['.venv', 'node_modules', '.credentials.yaml', '.env']:
            p = self.candidate / name
            p.write_text('not source')
            with self.assertRaises(ManagementError):
                inspect_package(self.candidate)
            p.unlink()

    def test_ignored_development_metadata_does_not_change_publication_digest(self):
        before = inspect_package(self.candidate)['digest']
        (self.candidate / '.git').mkdir()
        (self.candidate / '.git/config').write_text('local development state')
        (self.candidate / '.DS_Store').write_bytes(b'development noise')
        (self.candidate / '__pycache__').mkdir()
        (self.candidate / '__pycache__/fixture.pyc').write_bytes(b'bytecode')
        self.assertEqual(inspect_package(self.candidate)['digest'], before)

    def test_version_evidence_is_retained_without_choosing_a_winner(self):
        path = self.candidate / 'SKILL.md'
        path.write_text(path.read_text().replace('metadata:', 'version: 2.0.0\nmetadata:'))
        evidence = inspect_package(self.candidate)
        self.assertEqual(evidence['versions'], {'frontmatter.version': '2.0.0', 'metadata.version': 'v1'})
        self.assertEqual(evidence['license'], 'MIT')

    def test_cli_inspection_does_not_initialize_home(self):
        home = self.root / 'home'
        home.mkdir()
        entry = Path(__file__).resolve().parents[1] / 'manage.py'
        result = subprocess.run([sys.executable, str(entry), '--home', str(home), 'inspect',
                                 '--source', str(self.candidate)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['name'], 'fixture-skill')
        self.assertEqual(list(home.iterdir()), [])

    @unittest.skipIf(sys.platform == 'darwin', 'Unsupported-platform guard is exercised on Linux/Windows CI')
    def test_unsupported_lifecycle_refuses_before_initializing_state(self):
        home = self.root / 'home'
        home.mkdir()
        with self.assertRaises(ManagementError):
            Manager(home).stage(self.candidate)
        self.assertEqual(list(home.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
