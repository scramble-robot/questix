"""Only temporary files; no systemctl, no authorize operation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('manual',Path(__file__).parents[1]/'deploy/validate_manual_start.py')
manual=importlib.util.module_from_spec(spec);spec.loader.exec_module(manual)
class ManualStartTest(unittest.TestCase):
    def test_valid_intent_and_invalid_variants(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'mode').write_text('lesson\n');(p/'boot').write_text('boot\n')
            text='mode=lesson\nrequested_at=100\nboot_id=boot\n'
            (p/'start-request').write_text(text)
            self.assertEqual(manual.validate(p,p/'boot',100),'lesson')
            for replacement in (text+'mode=lesson\n',text.replace('boot_id=boot','boot_id=old'),text.replace('100','999'),text.replace('lesson','practice')):
                (p/'start-request').write_text(replacement)
                with self.assertRaises(ValueError):manual.validate(p,p/'boot',100)
            (p/'start-request').write_text(text)
            with self.assertRaises(ValueError):manual.validate(p,p/'boot',221)
            (p/'mode').write_text('competition')
            with self.assertRaises(ValueError):manual.validate(p,p/'boot',100)


class PrivilegedHelperTest(unittest.TestCase):
    def test_authorize_child_has_a_fixed_environment(self):
        from unittest.mock import mock_open, patch, Mock
        result = Mock(returncode=0)
        with patch.object(manual, 'validate_deployment'), patch.object(manual, 'validate'), \
                patch('builtins.open', mock_open()), patch.object(manual.fcntl, 'flock'), \
                patch.object(manual.subprocess, 'run', return_value=result) as run:
            self.assertEqual(manual.main(), 0)
            self.assertEqual(run.call_args.kwargs['env'], {'PATH':'/usr/bin:/bin','LANG':'C'})
            self.assertEqual(run.call_args.args[0], ['/opt/questix_pwm_guard/questix_pwm_ctl','authorize'])

    def test_partial_deployment_never_authorizes(self):
        from unittest.mock import mock_open, patch
        with patch.object(manual, 'validate_deployment', side_effect=ValueError('PARTIAL')), \
                patch('builtins.open', mock_open()), patch.object(manual.fcntl, 'flock'), \
                patch.object(manual.subprocess, 'run') as run:
            self.assertEqual(manual.main(), 1)
            run.assert_not_called()

    def test_unit_removes_user_environment_before_both_privileged_helpers(self):
        text=(Path(__file__).parents[1]/'systemd/50-rp1-pwm.conf').read_text()
        self.assertIn('EnvironmentFile=\n', text)
        self.assertIn('ExecStartPre=+/usr/bin/python3 -I ', text)
        self.assertIn('ExecStopPost=+/opt/questix_pwm_guard/questix_pwm_ctl low', text)

if __name__=='__main__':unittest.main()
