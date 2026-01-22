# Raspberry Pi Setup Role

This role installs Raspberry Pi specific utilities and configures user groups for GPIO access.

## Requirements

- Ubuntu 24.04 on Raspberry Pi 5
- ARM64 architecture

## Role Variables

- `target_user`: The user to configure (default: `ansible_user` or `ansible_env.SUDO_USER`)

## Dependencies

None

## Example Playbook

```yaml
- hosts: all
  roles:
    - role: raspberry_pi_setup
      vars:
        target_user: pi
```

## License

MIT
