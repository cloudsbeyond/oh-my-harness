import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ENTRY = Path(__file__).resolve().parents[1] / 'manage.py'


class CliTests(unittest.TestCase):
    def test_help_and_empty_audit_do_not_initialize_user_state(self):
        with tempfile.TemporaryDirectory(prefix='omh-skill-cli-') as tmp:
            home = Path(tmp).resolve()
            for arguments in [[], ['audit']]:
                result = subprocess.run([sys.executable, str(ENTRY), '--home', str(home), *arguments], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse((home / '.agents').exists())

    def test_cli_review_digest_is_required_and_reports_refusal(self):
        with tempfile.TemporaryDirectory(prefix='omh-skill-cli-') as tmp:
            home = Path(tmp).resolve()
            result = subprocess.run([sys.executable, str(ENTRY), '--home', str(home), 'install', '--stage', '0' * 32, '--expect-source', '0' * 64], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stderr)['status'], 'refused')


if __name__ == '__main__':
    unittest.main()
