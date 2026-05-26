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

Edit `config/gpio_reader.yaml` to configure:

- `chip_name`: GPIO chip name (default: "gpiochip4" for Raspberry Pi 5)
- `gpio_pins`: List of GPIO pins to monitor (BCM numbering)
- `publish_rate`: Publishing frequency in Hz
- `publish_individual`: Publish individual Bool topics for each pin
- `publish_joy`: Publish combined Joy message

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

This package uses BCM (Broadcom) GPIO numbering. Common pins on Raspberry Pi 5:

- GPIO 17 (Physical pin 11)
- GPIO 27 (Physical pin 13)
- GPIO 22 (Physical pin 15)
- GPIO 23 (Physical pin 16)
- GPIO 24 (Physical pin 18)

## Permissions

To access GPIO without root privileges, add your user to the gpio group:

```bash
sudo usermod -a -G gpio $USER
```

Then log out and log back in for the changes to take effect.

## Example: Reading GPIO States

```bash
# Monitor combined GPIO state
ros2 topic echo /gpio/state

# Monitor individual GPIO pin
ros2 topic echo /gpio_17
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
