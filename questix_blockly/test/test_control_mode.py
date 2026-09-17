"""Exercise input arbitration without sending commands to the running simulation."""
import time
import unittest
from types import SimpleNamespace
import rclpy
from sensor_msgs.msg import Joy
from bridge import Bridge


class ControlModeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rclpy.init()

    @classmethod
    def tearDownClass(cls):
        rclpy.shutdown()

    def setUp(self):
        self.node = Bridge()
        self.messages = []
        self.node.pub = SimpleNamespace(publish=self.messages.append)
        self.node.last_odom = time.monotonic()

    def tearDown(self):
        self.node.destroy_node()

    def joy(self, speed=0., a=0, b=0):
        self.node.on_controller(Joy(axes=[0., speed, 0., 0., 0., 0.],
                                    buttons=[a, b]+[0]*19))

    def test_blockly_ignores_controller(self):
        self.joy(1., a=1)
        self.node.tick()
        self.assertEqual(self.messages[-1].axes[1], 0.)
        self.assertEqual(self.messages[-1].buttons[1], 1)

    def test_neutral_start_stop_and_disconnect(self):
        self.node.command('/api/mode', {'mode':'controller'})
        self.joy(1., a=1)
        self.node.tick()
        self.assertFalse(self.node.controller_armed)
        self.joy(a=1)
        self.joy(0.4)
        self.node.tick()
        self.assertAlmostEqual(self.messages[-1].axes[1], 0.4)
        self.joy(a=1, b=1)
        self.node.tick()
        self.assertFalse(self.node.controller_armed)
        self.assertEqual(self.messages[-1].buttons[1], 1)
        self.joy(a=1)
        self.node.last_controller = time.monotonic()-1.
        self.node.tick()
        self.assertFalse(self.node.controller_armed)
        self.joy(0.4)
        self.node.tick()
        self.assertEqual(self.messages[-1].axes[1], 0.)
        self.joy(a=1)
        self.assertTrue(self.node.controller_armed)

    def test_switch_cancels_run_and_excludes_other_source(self):
        self.node.command('/api/run', {'id':'test', 'plan':[dict(v=0.3,w=0.,seconds=2.)]})
        self.node.command('/api/mode', {'mode':'controller'})
        self.assertFalse(self.node.plan)
        with self.assertRaises(ValueError):
            self.node.command('/api/run', {'id':'new', 'plan':[dict(v=0.3,w=0.,seconds=2.)]})
        self.node.command('/api/mode', {'mode':'blockly'})
        with self.assertRaises(ValueError):
            self.node.command('/api/run', {'id':'test', 'plan':[dict(v=0.3,w=0.,seconds=2.)]})


if __name__ == '__main__':
    unittest.main()
