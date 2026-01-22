# Hardware Interfaces Role

This role configures hardware interfaces (I2C, SPI) and udev rules for robotics hardware on Raspberry Pi.

## Requirements

- Raspberry Pi 5 with Ubuntu 24.04
- Root/sudo access

## Role Variables

- `boot_config_path`: Path to boot config file (default: `/boot/firmware/config.txt`)
- `udev_rules_path`: Path to udev rules file (default: `/etc/udev/rules.d/99-robot-hardware.rules`)
- `enable_i2c`: Enable I2C interface (default: `true`)
- `enable_spi`: Enable SPI interface (default: `true`)
- `configure_udev_rules`: Configure udev rules (default: `true`)

## Dependencies

None

## Example Playbook

```yaml
- hosts: all
  roles:
    - role: hardware_interfaces
      vars:
        enable_i2c: true
        enable_spi: true
```

## License

MIT
