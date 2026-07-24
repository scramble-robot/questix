# GPIO Reader

ROS2 package for reading GPIO values on Raspberry Pi 5 using libgpiod.

## Features

- Read multiple GPIO pins simultaneously
- Publish GPIO states as individual Bool topics
- Publish combined GPIO states as Joy message (for compatibility with other nodes)
- Implemented as ROS2 component for better performance and composability
- Configurable publish rate and GPIO pins

## Dependencies

- Ubuntu 24.04 with ROS 2 Jazzy
- Build dependency: `libgpiod-dev` (libgpiod headers and libraries)
- Optional GPIO inspection tools: `gpiod`

### Installing Dependencies on Raspberry Pi 5

```bash
sudo apt-get update
sudo apt-get install -y libgpiod-dev
```

Install `gpiod` only when you want command-line GPIO inspection tools such as
`gpiodetect` and `gpioinfo`:

```bash
sudo apt-get install -y gpiod
gpiodetect
```

## Configuration

The launch profiles are the single source of truth for monitored pins:

- `config/gpio_reader.practice.yaml`: GPIO5 only
- `config/gpio_reader.competition.yaml`: GPIO5 and GPIO27
- `config/gpio_reader.yaml`: backward-compatible safe default, identical to
  the practice profile

`questix_core.launch.xml` selects the practice profile by default and the
competition profile only when `enable_autoreferee:=true`.

GPIO values are published as raw electrical Bool values; this package does not
invert either input:

- GPIO5: physical emergency-stop indication, `false` = released/safe and
  `true` = pressed/stop (safe-low, stop-high)
- GPIO27: AutoReferee `AR_in`, `true` = permission/safe and `false` =
  stop (safe-high, stop-low), competition only

The AutoReferee client defeat output is 5 V when defeated and 0 V otherwise.
The HAT optocoupler inverts it: defeated turns the optocoupler on and produces
GPIO27 `false`; not defeated leaves it off and R2 (10 kΩ) pulls GPIO27 to
3.3 V/`true`. AutoReferee disconnected, client unpowered, and a primary-side
open circuit also produce `true`. Current hardware cannot distinguish those
conditions from a genuine not-defeated/permission state.

The physical emergency-stop circuit cuts actuator power in hardware through
RLY1. It removes power from both DDT drive motors, the roller ESC, the Shot
servo, and the Tilt servo. Raspberry Pi, 5 V I/O, and 3.3 V I/O remain powered,
so GPIO5 continues reporting the physical E-stop state to ROS. Hardware power
removal and the independent ROS software stop are two separate safety paths.

Each YAML configures:

- `chip_name`: GPIO chip name (default: "gpiochip4" for Raspberry Pi 5)
- `gpio_pins`: List of GPIO pins to monitor (BCM numbering)
- `publish_rate`: Publishing frequency in Hz

## Building

```bash
cd ~/workspace/shr_ws/questy
colcon build --packages-select gpio_reader
source install/setup.bash
```

## Usage

### Running as standalone node

```bash
ros2 launch gpio_reader gpio_reader.launch.py
```

### Running as component

```bash
ros2 launch gpio_reader gpio_reader_component.launch.py
```

### With custom configuration

```bash
ros2 launch gpio_reader gpio_reader.launch.py config_file:=/path/to/custom_config.yaml
```

## Topics

### Published Topics

- `gpio/state` (sensor_msgs/Joy): Combined state of all GPIO pins as Joy message
- `gpio_<PIN>` (std_msgs/Bool): Individual topic for each GPIO pin (if enabled)

## GPIO Pin Numbering

This package uses BCM (Broadcom) GPIO numbering. QUESTiX safety inputs:

- GPIO5: physical emergency stop (HAT CN10 pin 3 / IO3)
- GPIO27: competition AutoReferee `AR_in`

## Permissions

To access GPIO without root privileges, add your user to the gpio group:

```bash
sudo usermod -a -G gpio $USER
```

Then log out and log back in for the changes to take effect.

## Example: Reading GPIO States

```bash
# GPIO5 is present in both profiles
ros2 topic echo /gpio_5

# GPIO27 is present only in the competition profile
ros2 topic echo /gpio_27
```

## Component Composition

You can compose this component with other ROS2 components for better performance:

```python
from launch_ros.descriptions import ComposableNode

ComposableNode(
    package='gpio_reader',
    plugin='gpio_reader::GpioReaderComponent',
    name='gpio_reader_node',
    parameters=[config_file],
)
```

## Troubleshooting

### Cannot open GPIO chip

- Make sure you're using the correct chip name (gpiochip4 for Raspberry Pi 5)
- Check available chips: `gpiodetect`
- Verify permissions: `ls -l /dev/gpiochip*`

### GPIO pin not found

- Verify the pin number using BCM numbering
- Check pin availability: `gpioinfo gpiochip4`
- Some pins may be reserved by the system

## License

MIT
