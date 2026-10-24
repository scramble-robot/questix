"""Generic display labels must preserve the existing controller API identifiers."""

import re
from typing import get_args

from robot_manager import controls


def test_generic_schema_labels_keep_the_controller_values():
    assert get_args(controls.Controller) == ('uart', 'dualshock', 'web')
    assert controls.GROUPS['joy_node'][0] == 'ゲームパッドの入力'
    for controller in get_args(controls.Controller):
        for group in controls.schema(controller):
            assert not re.search(r'DualShock|DUALSHOCK|Switch|SWITCH', group['label'])
            for field in group['fields']:
                assert not re.search(r'DualShock|DUALSHOCK|Switch|SWITCH', field['label'])
