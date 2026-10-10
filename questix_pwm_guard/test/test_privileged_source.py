"""Exercise privileged source preflight under fixture ownership; no root deployment."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).parents[2]
SPEC = importlib.util.spec_from_file_location('seal', REPO/'questix_pwm_guard/deploy/review_manifest.py')
seal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seal)


class PrivilegedSourceTest(unittest.TestCase):
    def exercise(self, variant):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);source=base/'source';hostile=base/'hostile';hostile.mkdir()
            for file in seal.source_files(REPO):
                target=source/file.relative_to(REPO)
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(file,target)
            script=source/'questix_pwm_guard/deploy/install_reviewed.sh'
            preflight=script.read_text().split('PY_SOURCE\n',1)[0]+'PY_SOURCE\n}\ncheck_reviewed_source\ncommand -v id\nexit 0\n'
            preflight=preflight.replace('info.st_uid != 0','info.st_uid != '+str(os.getuid()))
            preflight=preflight.replace('for candidate in (path,*path.parents):',
                f'for candidate in (path,*(p for p in path.parents if p == Path({str(source)!r}) '
                f'or Path({str(source)!r}) in p.parents)):')
            script.write_text(preflight)
            for path in (source,*source.rglob('*')):
                path.chmod(0o755 if path.is_dir() else 0o644)
            data={'schema':1,'contract':'rp1-installer-source-v1','source_digest':seal.digest(source),
                  'source_files':{str(p.relative_to(source)):seal.sha(p) for p in seal.source_files(source)}}
            receipt=source/'reviewed-installer-source.json'
            receipt.write_text(json.dumps(data));receipt.chmod(0o600)
            marker=base/'HOSTILE_EXECUTED'
            for tool in ('realpath','id','uname','install','python3'):
                file=hostile/tool;file.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\nexit 77\n');file.chmod(0o755)
            if variant=='tamper':(source/'questix_pwm_guard/deploy/review_manifest.py').write_text('changed')
            elif variant=='writable':(source/'questix_pwm_guard/deploy').chmod(0o777)
            elif variant=='receipt':receipt.chmod(0o644)
            elif variant=='link':
                file=source/'questix_pwm_guard/deploy/review_manifest.py'
                content=file.read_text();file.unlink();outside=base/'outside';outside.write_text(content);file.symlink_to(outside)
            run=subprocess.run(['/usr/bin/env','-i','PATH='+str(hostile),'/bin/bash','--noprofile','--norc',str(script)],
                               capture_output=True,text=True,timeout=15)
            self.assertFalse(marker.exists(),run.stdout+run.stderr)
            if variant=='success':
                self.assertEqual(run.returncode,0,run.stderr)
                self.assertEqual(run.stdout.strip(),'/usr/bin/id')
            else:self.assertNotEqual(run.returncode,0)

    def test_hostile_path_does_not_run_alternative_tools(self):
        self.exercise('success')

    def test_modified_helper_and_unprotected_source_are_rejected(self):
        for variant in ('tamper','writable','receipt','link'):
            with self.subTest(variant=variant):self.exercise(variant)


if __name__=='__main__':
    unittest.main()
