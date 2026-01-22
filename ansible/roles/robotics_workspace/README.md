# Robotics Workspace Role

This role creates a ROS2 robotics workspace and configures bash environment with useful aliases.

## Requirements

- ROS2 installed
- User account for workspace creation

## Role Variables

- `target_user`: The user for workspace creation (default: `ansible_user` or `ansible_env.SUDO_USER`)
- `workspace_path`: Path to create workspace (default: `/home/{{ target_user }}/robot_ws`)
- `bashrc_path`: Path to bashrc file (default: `/home/{{ target_user }}/.bashrc`)
- `ros_domain_id`: ROS2 domain ID (default: `42`)

## Dependencies

None

## Example Playbook

```yaml
- hosts: all
  roles:
    - role: robotics_workspace
      vars:
        workspace_path: /home/pi/my_robot_ws
        ros_domain_id: 10
```

## License

MIT
