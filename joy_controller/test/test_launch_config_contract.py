# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""Hardware-free XML launch configuration contract regression tests."""
import pathlib
import unittest
import xml.etree.ElementTree as ET


class LaunchConfigContract(unittest.TestCase):
    """Check mode-specific defaults, overrides and conditions."""

    def test_mode_specific_configuration(self):
        """Each mode must consume its own declared YAML argument."""
        root_dir = pathlib.Path(__file__).resolve().parents[1]
        root = ET.parse(root_dir / 'launch/joy_controller.launch.xml').getroot()
        args = {arg.attrib['name']: arg.attrib['default'] for arg in root.findall('arg')}
        cases = [
            ('joy_controller_node', 'config_file', 'joy_controller_params.yaml', 'unless'),
            ('joy_controller_dual_stick_node', 'dual_stick_config_file',
             'joy_controller_dual_stick_params.yaml', 'if'),
        ]
        for executable, argument, filename, condition in cases:
            with self.subTest(mode=executable):
                self.assertEqual(args[argument],
                                 '$(find-pkg-share joy_controller)/config/' + filename)
                self.assertTrue((root_dir / 'config' / filename).is_file())
                node = root.find("node[@exec='" + executable + "']")
                self.assertIsNotNone(node)
                self.assertEqual(node.attrib[condition], '$(var dual_stick)')
                self.assertEqual([p.attrib['from'] for p in node.findall('param')
                                  if 'from' in p.attrib], ['$(var ' + argument + ')'])
                self.assertEqual(node.findall('param')[-1].attrib,
                                 {'name': 'joy_topic', 'value': '$(var joy_topic)'})


if __name__ == '__main__':
    unittest.main()
