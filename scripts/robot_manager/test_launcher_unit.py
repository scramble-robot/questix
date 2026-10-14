"""Contract tests for launcher config failures and installed unit restart policy.

Render the actual installer substitutions and exercise updater functions with temporary paths
and a mocked systemctl command; never install a unit or contact the host service manager.
"""

import configparser
import os
from pathlib import Path
import subprocess

import pytest

REPO = Path(__file__).resolve().parents[2]
UNIT = REPO / 'systemd/questix_robot.service'
TEMPLATE = REPO / 'ansible/roles/robot_autostart/templates/questix_robot.service.j2'
POLICY = REPO / 'systemd/questix_robot.service.d/launcher-config.conf'
UPDATER = REPO / 'scripts/update-robot-manager.sh'


def service_settings(text):
    """Read the settings of interest while allowing repeated Environment directives."""
    config = configparser.ConfigParser(strict=False, interpolation=None)
    config.read_string(text)
    return config['Service']


def test_unit_policy_matches_ansible_and_actual_installer_rendering():
    """Every install path prevents retry of EX_CONFIG while preserving normal crash retry."""
    installer = (REPO / 'scripts/install-robot-manager.sh').read_text()
    end = installer.index(' > /etc/systemd/system/questix_robot.service')
    begin = installer.rfind('\nsed \\\n', 0, end)
    assert begin >= 0
    command = installer[begin:end]
    environment = dict(os.environ, REPO_DIR=str(REPO), TARGET_USER='test_operator',
                       ROS_DISTRO='jazzy', ROBOT_WS='/home/test_operator/test_ws')
    rendered = subprocess.run(['bash', '-eu', '-c', command], env=environment,
                              text=True, capture_output=True, check=True).stdout
    # This unit template contains only these literal substitutions; require no new test dependency.
    ansible = TEMPLATE.read_text()
    for key, value in {'target_user': 'test_operator', 'ros2_distro': 'jazzy',
                       'workspace_path': '/home/test_operator/test_ws'}.items():
        ansible = ansible.replace('{{ ' + key + ' }}', value)
    assert '{{' not in ansible and '{%' not in ansible
    for text in (UNIT.read_text(), ansible, rendered):
        settings = service_settings(text)
        assert settings['Restart'] == 'on-failure'
        assert settings['RestartPreventExitStatus'] == '78'
        assert '78' not in settings.get('SuccessExitStatus', '').split()
    assert service_settings(POLICY.read_text())['RestartPreventExitStatus'] == '78'
    for text in (ansible, rendered):
        assert service_settings(text)['User'] == 'test_operator'
        assert 'Environment=ROBOT_WS=/home/test_operator/test_ws' in text


@pytest.mark.parametrize('reload_code', [0, 1])
def test_updater_installs_refusal_policy_before_launcher_without_restart(tmp_path, reload_code):
    """Old installs receive the drop-in, and a reload failure prevents launcher replacement."""
    text = UPDATER.read_text()
    begin = text.index('LAUNCHER_SOURCE=')
    end = text.index('# QUESTiX Local (', begin)
    functions = text[begin:end]
    installed = tmp_path / 'installed'
    installed.mkdir()
    launcher = installed / 'questix_robot_launcher.sh'
    launcher.write_text('old launcher\n')
    dropin = tmp_path / 'questix_robot.service.d'
    calls = tmp_path / 'systemctl.calls'
    harness = tmp_path / 'updater-test.sh'
    harness.write_text('set -euo pipefail\n' + functions + '''
LAUNCHER_POLICY_DIR="$TEST_DROPIN_DIR"
LAUNCHER_POLICY_TARGET="$LAUNCHER_POLICY_DIR/launcher-config.conf"
systemctl() {
    printf '%s\\n' "$*" >> "$TEST_SYSTEMCTL_CALLS"
    return "$TEST_RELOAD_CODE"
}
# Matching launcher alone must not hide a missing restart policy.
cp "$LAUNCHER_SOURCE" "$LAUNCHER_TARGET"
if launcher_current; then exit 41; fi
printf 'old launcher\\n' > "$LAUNCHER_TARGET"
install_launcher
launcher_current
printf '[Service]\\nRestartPreventExitStatus=1\\n' > "$LAUNCHER_POLICY_TARGET"
if launcher_current; then exit 42; fi
''')
    environment = dict(os.environ, REPO_ROOT=str(REPO), INSTALL_DIR=str(installed),
                       TEST_DROPIN_DIR=str(dropin), TEST_SYSTEMCTL_CALLS=str(calls),
                       TEST_RELOAD_CODE=str(reload_code))
    result = subprocess.run(['bash', str(harness)], env=environment, text=True,
                            capture_output=True, timeout=10, check=False)
    assert result.returncode == reload_code, result.stderr
    assert calls.read_text().splitlines() == ['daemon-reload']
    if reload_code:
        assert launcher.read_text() == 'old launcher\n'
        assert (dropin / 'launcher-config.conf').read_bytes() == POLICY.read_bytes()
    else:
        assert launcher.read_bytes() == (REPO / 'systemd/questix_robot_launcher.sh').read_bytes()
