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
        cases = [
            ('joy_controller_node', 'config_file', 'joy_controller_params.yaml', 'unless'),
            ('joy_controller_dual_stick_node', 'dual_stick_config_file',
             'joy_controller_dual_stick_params.yaml', 'if'),
        ]
        for launch_file, joy_topic in [
            ('joy_controller.launch.xml', '/joy'),
            ('joy_controller_referee.launch.xml', '/joy_gated'),
        ]:
            root = ET.parse(root_dir / 'launch' / launch_file).getroot()
            args = {arg.attrib['name']: arg.attrib['default'] for arg in root.findall('arg')}
            self.assertEqual(args['joy_topic'], joy_topic)
            for executable, argument, filename, condition in cases:
                with self.subTest(launch=launch_file, mode=executable):
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

    def test_dual_yaml_selector_survives_node_rename(self):
        """Wildcard YAML must apply to standalone and launch-renamed nodes."""
        root_dir = pathlib.Path(__file__).resolve().parents[1]
        config_path = root_dir / 'config/joy_controller_dual_stick_params.yaml'
        lines = config_path.read_text().splitlines()
        content = [line for line in lines if line.strip() and not line.lstrip().startswith('#')]
        self.assertEqual([line for line in content if not line[0].isspace()], ['/**:'])
        self.assertEqual(content[1], '  ros__parameters:')


if __name__ == '__main__':
    unittest.main()
