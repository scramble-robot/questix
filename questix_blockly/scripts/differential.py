"""Use production slew, wheel conversion and stop gating with ideal wheel response."""
import ctypes
from pathlib import Path
import yaml
from ament_index_python.packages import get_package_prefix, get_package_share_directory

FIELDS = ('max_linear_accel', 'max_angular_accel', 'min_linear_accel',
          'min_angular_accel', 'accel_demand_ref_linear', 'accel_demand_ref_angular',
          'slew_taper_band_linear', 'slew_taper_band_angular', 'wheel_radius',
          'wheel_separation', 'min_command_rpm')


class DifferentialDrive:
    def __init__(self):
        root = Path(get_package_prefix('questix_blockly')) / 'lib'
        self.config = yaml.safe_load((Path(get_package_share_directory('questix_launcher')) / 'config/drive_component.yaml')
                                     .read_text())['drive_component']['ros__parameters']
        self.lib = ctypes.CDLL(str(root / 'libquestix_control.so'))
        self.lib.questix_create.argtypes = [ctypes.POINTER(ctypes.c_double)]
        self.lib.questix_create.restype = ctypes.c_void_p
        self.lib.questix_reset.argtypes = [ctypes.c_void_p]
        self.lib.questix_destroy.argtypes = [ctypes.c_void_p]
        self.lib.questix_step.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double,
                                         ctypes.c_double, ctypes.c_int,
                                         ctypes.POINTER(ctypes.c_double)]
        self.ptr = self.lib.questix_create((ctypes.c_double * len(FIELDS))(
            *(self.config[name] for name in FIELDS)))
        self.limit = min(475, int(self.config['max_motor_rpm']))

    def step(self, v, w, dt):
        result = (ctypes.c_double * 4)()
        self.lib.questix_step(self.ptr, v, w, dt, self.limit, result)
        return tuple(result)

    def reset(self):
        self.lib.questix_reset(self.ptr)

    def close(self):
        if self.ptr:
            self.lib.questix_destroy(self.ptr)
            self.ptr = None
