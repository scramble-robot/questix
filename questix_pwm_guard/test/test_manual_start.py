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
if __name__=='__main__':unittest.main()
