"""Use production slew, wheel conversion and stop gating with ideal wheel response."""
import ctypes
from pathlib import Path
import yaml
from ament_index_python.packages import get_package_prefix, get_package_share_directory

# Order must match the p[] indices in src/control_bridge.cpp (questix_create).
FIELDS = ('max_linear_accel', 'max_angular_accel',
          'slew_taper_band_linear', 'slew_taper_band_angular', 'wheel_radius',
          'wheel_separation', 'min_command_rpm')


def _ros_parameters(path, node):
    return yaml.safe_load(Path(path).read_text())[node]['ros__parameters']


def drive_parameters():
    """Drive hardware (wheels) from questix_launcher, operator tuning from the packaged profile.

    Acceleration, taper, deadband and the RPM limit live in questix_control_config's
    controls.uart.yaml (the robot's default controller); drive_component.yaml keeps the rest.
    """
    hardware = Path(get_package_share_directory('questix_launcher')) / 'config/drive_component.yaml'
    profile = (Path(get_package_share_directory('questix_control_config'))
               / 'config/controls.uart.yaml')
    return {**_ros_parameters(hardware, 'drive_component'),
            **_ros_parameters(profile, 'drive_component')}


class DifferentialDrive:
    def __init__(self):
        root = Path(get_package_prefix('questix_blockly')) / 'lib'
        self.config = drive_parameters()
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
