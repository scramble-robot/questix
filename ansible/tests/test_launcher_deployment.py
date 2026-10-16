"""Launcher acceptance checks must agree with every deployment path."""

import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


class LauncherDeploymentTest(unittest.TestCase):
    def setUp(self):
        self.script = (ROOT / "scripts/update-robot-manager.sh").read_text()
        self.body = re.search(r"^launcher_current\(\) \{\n(.*?)^}", self.script,
                              re.M | re.S).group(0)
        self.variables = {"REPO_ROOT": str(ROOT), "INSTALL_DIR": "/opt/questix_robot"}
        for name, value in re.findall(r'^([A-Z_]+)=(.*)$', self.script, re.M):
            if name.startswith("LAUNCHER_"):
                self.variables[name] = self.expand(value.strip('"'))
        # Discover every comparison, including future additions. Unsupported syntax fails.
        self.pairs = []
        for line in self.body.replace("\\\n", " ").replace("&&", "\n").splitlines():
            if "cmp " in line:
                tokens = shlex.split(line.strip())
                self.assertEqual(tokens[:2], ["cmp", "-s"])
                self.assertIn(len(tokens), (4, 5))
                self.pairs.append(tuple(self.expand(x) for x in tokens[2:4]))
        self.assertTrue(self.pairs)
        self.deployments = {}
        self.directories = {}
        for path in (ROOT / "ansible/roles").glob("*/tasks/*.yaml"):
            for task in yaml.safe_load(path.read_text()) or []:
                for module in ("copy", "template", "file"):
                    spec = task.get("ansible.builtin." + module, {})
                    dest = spec.get("dest", spec.get("path", ""))
                    if not isinstance(dest, str) or not dest.startswith("/"):
                        continue
                    if module == "file":
                        self.directories[dest] = spec
                    elif "src" in spec:
                        source = spec["src"].replace("{{ playbook_dir }}/../../", str(ROOT) + "/")
                        if not source.startswith("/"):
                            source = str(path.parent.parent / ("files" if module == "copy"
                                                              else "templates") / source)
                        self.deployments[dest] = (Path(source), spec, task)

    def expand(self, value):
        return re.sub(r"\$\{?([A-Z_]+)\}?", lambda m: self.variables[m[1]], value)

    def test_all_compared_files_are_deployed(self):
        for source, target in self.pairs:
            with self.subTest(target=target):
                self.assertIn(target, self.deployments)
                deployed, spec, task = self.deployments[target]
                self.assertEqual(deployed.read_bytes(), Path(source).read_bytes())
                self.assertEqual((spec["owner"], spec["group"]), ("root", "root"))
                self.assertEqual(spec["mode"], "0755" if target.endswith(".sh") else "0644")
                if ".service.d/" in target:
                    self.assertEqual(deployed.resolve(), Path(source).resolve())
                    if target.endswith("/launcher-config.conf"):
                        self.assertEqual(task["notify"], "reload_systemd")
                    directory = self.directories[str(Path(target).parent)]
                    self.assertEqual((directory["owner"], directory["group"], directory["mode"]),
                                     ("root", "root", "0755"))

    def test_ansible_state_satisfies_actual_launcher_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # Reconstruct only Ansible's declared deployment, never the updater's install.
            for target, (source, spec, _) in self.deployments.items():
                if source.is_file() and "{{" not in str(source):
                    dest = base / target.lstrip("/")
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, dest)
                    dest.chmod(int(spec["mode"], 8))
            body = self.body
            env = dict(os.environ, **self.variables)
            for name in ("LAUNCHER_TARGET", "LAUNCHER_POLICY_DIR", "LAUNCHER_POLICY_TARGET"):
                if name in env:
                    env[name] = str(base / env[name].lstrip("/"))
            def check():
                return subprocess.run(["bash", "-c", body + "\nlauncher_current"],
                                      env=env, capture_output=True).returncode
            self.assertEqual(check(), 0, "Ansible state fails the real acceptance function")
            dropin = base / "etc/systemd/system/questix_robot.service.d/launcher-config.conf"
            original = dropin.read_bytes()
            dropin.unlink()
            self.assertNotEqual(check(), 0)
            dropin.write_bytes(b"different policy\n")
            self.assertNotEqual(check(), 0)
            dropin.write_bytes(original)
            self.assertEqual(check(), 0)

    def test_installer_deploys_launcher_policy(self):
        script = (ROOT / "scripts/install-robot-manager.sh").read_text().replace("\\\n", " ")
        self.assertRegex(script, r'install -o root -g root -m 0644 "\$\{REPO_DIR}/systemd/'
                         r'questix_robot\.service\.d/launcher-config\.conf"\s+'
                         r'/etc/systemd/system/questix_robot\.service\.d/launcher-config\.conf')


if __name__ == "__main__":
    unittest.main()
