# GPIO Reader

ROS 2 package for reading GPIO values on Raspberry Pi 5 using libgpiod.

## Features

- Read multiple GPIO pins simultaneously
- Publish each configured GPIO pin as a raw `std_msgs/msg/Bool` topic
- Implemented as a ROS 2 component for composability
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
conditions from a genuine not-defeated/permission state. Diagnostics therefore
report this hardware limitation but cannot detect those three failure modes.

The physical emergency-stop circuit cuts actuator power in hardware through
RLY1. It removes power from both DDT drive motors, the roller ESC, the Shot
servo, and the Tilt servo. Raspberry Pi, 5 V I/O, and 3.3 V I/O remain powered,
so GPIO5 continues reporting the physical E-stop state to ROS. Hardware power
removal and the independent ROS software stop are two separate safety paths.

Each YAML configures:

- `chip_name`: GPIO chip device path (default: `/dev/gpiochip4`)
- `gpio_pins`: list of GPIO pins to monitor (BCM numbering)
- `publish_rate`: publishing frequency in Hz

## Building

```bash
cd <questix-workspace>
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

For every pin listed in `gpio_pins`, the node publishes exactly one raw electrical
topic named `/gpio_<PIN>` with type `std_msgs/msg/Bool`. For example, the practice
profile publishes `/gpio_5`; the competition profile publishes `/gpio_5` and
`/gpio_27`. The node does not publish a combined GPIO-state topic.

## GPIO Pin Numbering

This package uses BCM (Broadcom) GPIO numbering. The following table documents the
complete QUESTiX Raspberry Pi 5 HAT allocation in BCM order.

| BCM GPIO | Raspberry Pi physical pin | HAT signal / location | Assignment / notes |
|---:|---:|---|---|
| 0 | 27 | ID_SD | Reserved for HAT ID EEPROM; not used by QUESTiX |
| 1 | 28 | ID_SC | Reserved for HAT ID EEPROM; not used by QUESTiX |
| 2 | 3 | SDA; CN13/CN14 pin 3 | I2C SDA |
| 3 | 5 | SCL; CN13/CN14 pin 4; CN6 pin 3 / POW-SW | I2C SCL and power-switch input; shared net |
| 4 | 7 | J1 only | Unassigned |
| 5 | 29 | CN10 pin 3 / IO3 | Physical emergency stop; false=released, true=pressed |
| 6 | 31 | CN11 pin 3 / IO4 | Unassigned |
| 7 | 26 | CN5 pin 3 / CE1 | SPI CE1 |
| 8 | 24 | CN4 pin 3 / CE0 | SPI CE0 |
| 9 | 21 | CN15/CN16 pin 2 / MISO | SPI MISO |
| 10 | 19 | CN15/CN16 pin 3 / MOSI | SPI MOSI |
| 11 | 23 | CN15/CN16 pin 1 / SCK | SPI SCLK |
| 12 | 32 | CN2 pin 3 / PWM0 | Unassigned PWM output |
| 13 | 33 | CN3 pin 3 / PWM1 | Roller ESC motor control PWM output |
| 14 | 8 | CN12 pin 3 / TXD through level shifter | UART TXD |
| 15 | 10 | CN12 pin 4 / RXD through level shifter | UART RXD |
| 16 | 36 | HAT SW1-4 | DIP Switch 4 |
| 17 | 11 | J1 only | Unassigned |
| 18 | 12 | J1 only | Unassigned |
| 19 | 35 | J1 only | Unassigned |
| 20 | 38 | HAT SW1-2 | DIP Switch 2 |
| 21 | 40 | HAT SW1-1 | DIP Switch 1 |
| 22 | 15 | J1 only | Unassigned |
| 23 | 16 | J1 only | Unassigned |
| 24 | 18 | CN9 pin 3 / IO2 | Unassigned |
| 25 | 22 | CN8 pin 3 / IO1 | Unassigned |
| 26 | 37 | HAT SW1-3 | DIP Switch 3 |
| 27 | 13 | AutoReferee AR_in, U2/R2; client connector CN7 | Competition AutoReferee; true=permission, false=stop |

Connector pin assignments:

- CN2--CN11: pin 1 = +3.3 V, pin 2 = GND, pin 3 = signal
- CN13/CN14: pin 1 = +3.3 V, pin 2 = GND, pin 3 = SDA, pin 4 = SCL
- CN15/CN16: pin 1 = SCK, pin 2 = MISO, pin 3 = MOSI, pin 4 = GND
- CN12: pin 1 = ConVcc, pin 2 = GND, pin 3 = TXD, pin 4 = RXD

## Permissions

To access GPIO without root privileges, add your user to the `gpio` group:

```bash
sudo usermod -a -G gpio "$USER"
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

You can compose this component with other ROS 2 components:

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

- Confirm that the configured device path is `/dev/gpiochip4` on Raspberry Pi 5
- Check available chips: `gpiodetect`
- Verify permissions: `ls -l /dev/gpiochip*`

### GPIO pin not found

- Verify the pin number using BCM numbering
- Check line information: `gpioinfo /dev/gpiochip4`
- Some pins may be reserved or claimed by the system

## License

MIT
