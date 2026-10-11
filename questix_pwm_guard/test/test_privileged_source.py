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
    def exercise(self, variant, script_name="install_reviewed.sh"):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);source=base/'source';hostile=base/'hostile';hostile.mkdir()
            for file in seal.source_files(REPO):
                target=source/file.relative_to(REPO)
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(file,target)
            script=source/'questix_pwm_guard/deploy'/script_name
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
            if variant=='three_only':
                required=['questix_pwm_guard/deploy/'+name for name in
                          ('install_reviewed.sh','rollback_reviewed.sh','review_manifest.py')]
                data['source_files']={name:data['source_files'][name] for name in required}
            elif variant=='omitted':
                del data['source_files']['questix_pwm_guard/deploy/validate_manual_start.py']
            elif variant=='stale_entry':
                data['source_files']['questix_pwm_guard/deploy/ghost.py']='0'*64
            records=''.join(f'{name}:{digest}\n' for name,digest in sorted(data['source_files'].items()))
            data['source_digest']=seal.hashlib.sha256(records.encode()).hexdigest()
            receipt=source/'reviewed-installer-source.json'
            receipt.write_text(json.dumps(data));receipt.chmod(0o600)
            marker=base/'HOSTILE_EXECUTED'
            for tool in ('realpath','id','uname','install','python3'):
                file=hostile/tool;file.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\nexit 77\n');file.chmod(0o755)
            if variant=='extra':(source/'questix_pwm_guard/deploy/unapproved.py').write_text('# extra')
            elif variant=='cache':
                cache=source/'questix_pwm_guard/deploy/__pycache__';cache.mkdir()
                cache.chmod(0o755)
                (cache/'generated.pyc').write_bytes(b'cache')
                (source/'questix_pwm_guard/deploy/generated.pyc').write_bytes(b'cache')
                (cache/'generated.pyc').chmod(0o644)
                (source/'questix_pwm_guard/deploy/generated.pyc').chmod(0o644)
            elif variant=='symlink_dir':(source/'questix_pwm_guard/alias').symlink_to(base,target_is_directory=True)
            elif variant=='fifo':os.mkfifo(source/'questix_pwm_guard/pipe')
            elif variant=='tamper':(source/'questix_pwm_guard/deploy/review_manifest.py').write_text('changed')
            elif variant=='writable':(source/'questix_pwm_guard/deploy').chmod(0o777)
            elif variant=='receipt':receipt.chmod(0o644)
            elif variant=='link':
                file=source/'questix_pwm_guard/deploy/review_manifest.py'
                content=file.read_text();file.unlink();outside=base/'outside';outside.write_text(content);file.symlink_to(outside)
            run=subprocess.run(['/usr/bin/env','-i','PATH='+str(hostile),'/bin/bash','--noprofile','--norc',str(script)],
                               capture_output=True,text=True,timeout=15)
            self.assertFalse(marker.exists(),run.stdout+run.stderr)
            if variant in ('success','cache'):
                self.assertEqual(run.returncode,0,run.stderr)
                self.assertEqual(run.stdout.strip(),'/usr/bin/id')
            else:self.assertNotEqual(run.returncode,0)

    def test_hostile_path_does_not_run_alternative_tools(self):
        for script in ('install_reviewed.sh','rollback_reviewed.sh'):
            with self.subTest(script=script):self.exercise('success',script)

    def test_modified_helper_and_unprotected_source_are_rejected(self):
        for script in ('install_reviewed.sh','rollback_reviewed.sh'):
            for variant in ('tamper','writable','receipt','link'):
                with self.subTest(script=script,variant=variant):self.exercise(variant,script)

    def test_incomplete_or_extra_inventory_is_rejected(self):
        for script in ('install_reviewed.sh','rollback_reviewed.sh'):
            for variant in ('three_only','omitted','stale_entry','extra'):
                with self.subTest(script=script,variant=variant):self.exercise(variant,script)

    def test_generated_cache_exclusion_is_consistent(self):
        for script in ('install_reviewed.sh','rollback_reviewed.sh'):
            with self.subTest(script=script):self.exercise('cache',script)

    def test_source_aliases_and_specials_are_rejected(self):
        for script in ('install_reviewed.sh','rollback_reviewed.sh'):
            for variant in ('symlink_dir','fifo'):
                with self.subTest(script=script,variant=variant):self.exercise(variant,script)


if __name__=='__main__':
    unittest.main()
