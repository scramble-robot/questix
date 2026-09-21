"""Analytical checks for the shared production control core + ideal wheel model."""
import math
import unittest
from differential import DifferentialDrive


class DifferentialTests(unittest.TestCase):
    def setUp(self):
        self.drive = DifferentialDrive()

    def tearDown(self):
        self.drive.close()

    def settle(self, v, w):
        for _ in range(300):
            out = self.drive.step(v, w, 0.02)
        return out

    def test_forward_and_reverse(self):
        for speed in (1., -1.):
            left, right, v, w = self.settle(speed, 0.)
            self.assertEqual(left, -right)  # mirrored right motor mounting
            self.assertAlmostEqual(v, speed, delta=0.006)
            self.assertEqual(w, 0.)

    def test_in_place_rotation(self):
        left, right, v, w = self.settle(0., 1.)
        self.assertEqual(left, right)  # physically opposite wheel directions
        self.assertEqual(v, 0.)
        self.assertAlmostEqual(w, 1., delta=0.03)

    def test_curved_motion_from_wheels(self):
        left, right, v, w = self.settle(1., 1.)
        radius = self.drive.config['wheel_radius']
        track = self.drive.config['wheel_separation']
        vl, vr = left * 2*math.pi*radius/60, -right * 2*math.pi*radius/60
        self.assertAlmostEqual(v, (vl+vr)/2)
        self.assertAlmostEqual(w, (vr-vl)/track)
        self.assertGreater(vr, vl)

    def test_acceleration_and_reset(self):
        _, _, v, _ = self.drive.step(2., 0., 0.02)
        self.assertLessEqual(v, 3.*0.02 + 0.006)
        self.settle(2., 0.)
        self.drive.reset()
        self.assertEqual(self.drive.step(0., 0., 0.02), (0., 0., 0., 0.))

    def test_rpm_limit(self):
        left, right, _, _ = self.settle(100., 100.)
        self.assertLessEqual(abs(left), 475)
        self.assertLessEqual(abs(right), 475)


if __name__ == '__main__':
    unittest.main()
