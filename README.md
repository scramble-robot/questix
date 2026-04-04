# ROS2 Robotics Kit - Automated ISO Builder

🤖 **Automated Ubuntu ISO builder with pre-configured ROS2 environment for robotics development**

This project provides a complete automation pipeline using Ansible and GitHub Actions to create custom Ubuntu ISO images with ROS2 and robotics development tools pre-installed.

## 🎯 Features

### 🖥️ Development Environment (AMD64)

- **Target**: Desktop/laptop development machines
- **OS**: Ubuntu 22.04 LTS with ROS2 Humble
- **Tools**: Full desktop environment, development tools, ROS2 Desktop
- **Workspace**: Pre-configured `~/ros2_ws`

### 🍓 Robotics Kit (ARM64 - Raspberry Pi 5)

- **Target**: Raspberry Pi 5 robotics projects
- **OS**: Ubuntu 24.04 LTS with ROS2 Jazzy
- **Hardware**: GPIO, I2C, SPI interfaces pre-configured
- **Tools**: Robotics libraries, hardware abstraction layers
- **Workspace**: Pre-configured `~/robot_ws`

## 🚀 Quick Start

### Using Pre-built ISOs (Recommended)

1. **Download from Releases**

   ```bash
   # Check latest releases
   wget https://github.com/your-username/questix_core/releases/latest
   ```

2. **Flash to Storage**

   ```bash
   # For Raspberry Pi 5 (ARM64)
   sudo dd if=ros2-robotics-kit-arm64-ubuntu24.04-ros2jazzy.iso of=/dev/sdX bs=4M status=progress
   
   # For PC/Laptop (AMD64) 
   sudo dd if=ros2-robotics-kit-amd64-ubuntu22.04-ros2humble.iso of=/dev/sdX bs=4M status=progress
   ```

3. **Boot and Install**
   - Boot from USB/SD card
   - Follow installation wizard
   - System ready for ROS2 development!

### Building Locally

1. **Setup Dependencies**

   ```bash
   git clone https://github.com/your-username/questix_core.git
   cd questix_core
   ansible-playbook ansible/playbooks/setup_kit.yaml -i localhost, --connection=local --ask-become-pass
   ```

2. **Build ISOs**

   ```bash
   # Build development environment ISO (AMD64)
   make build-dev
   
   # Build robotics kit ISO (ARM64)
   make build-kit
   
   # Build both
   make build-both
   ```

3. **Test Build**

   ```bash
   # Test Ansible playbooks
   make test-ansible
   
   # Test ISO with QEMU (AMD64 only)
   make test-iso-amd64
   ```

## 📁 Project Structure

```
questix_core/
├── .github/workflows/     # GitHub Actions CI/CD
│   └── build-iso.yml     # Automated ISO building
├── ansible/              # Ansible automation
│   ├── roles/ros2/       # ROS2 installation role
│   └── playbooks/        # Environment setup playbooks
├── scripts/              # ISO building scripts
│   ├── prepare-base-system.sh
│   ├── apply-ansible-config.sh
│   └── build-iso.sh
├── docker/               # Docker support
└── Makefile             # Local development commands
```

## 🔧 Customization

### Variables

Customize builds by setting environment variables:

```bash
# Use different ROS2 distribution
make build-dev ROS2_DISTRO=iron

# Target different Ubuntu version (override defaults)
make build-kit UBUNTU_VERSION=22.04  # Force older version for ARM64

# Custom architecture
make _build ARCHITECTURE=amd64 ROS2_DISTRO=jazzy
```

### Ansible Playbooks

Modify the Ansible playbooks in `ansible/playbooks/`:

- `setup_dev.yaml` - Development environment
- `setup_kit.yaml` - Robotics kit environment

### Additional Packages

Add packages to the `ros2_additional_packages` variable in playbooks:

```yaml
ros2_additional_packages:
  - ros-humble-navigation2
  - ros-humble-slam-toolbox
  - ros-humble-moveit
```

## 🐙 GitHub Actions

### Automated Builds

The GitHub Actions workflow automatically:

1. ✅ Validates Ansible playbooks
2. 🏗️ Builds ISOs for both architectures
3. 🧪 Tests ISO integrity
4. 📦 Creates GitHub releases
5. 🔐 Generates checksums

### Triggers

- **Push to main/develop**: Build and test
- **Tags (v*)**: Build and create release
- **Manual dispatch**: Custom parameters
- **Pull requests**: Validation only

### Manual Trigger

```bash
# Trigger manual build via GitHub CLI
gh workflow run build-iso.yml \
  --field ros2_distro=humble \
  --field ubuntu_version=22.04 \
  --field architecture=arm64
```

## 🧪 Testing

### Local Testing

```bash
# Validate Ansible
make test-ansible

# Test ISO boot (requires QEMU)
make test-iso-amd64

# Test GitHub Actions locally (requires act)
make github-test
```

### Post-Installation Testing

**Development Environment (AMD64):**

```bash
# After installation
source ~/.bashrc
ros2 --version
ros2 topic list
cw  # Navigate to workspace
```

**Robotics Kit (ARM64):**

```bash
# After installation and reboot
source ~/.bashrc
ros2 --version
gpio_status  # Check GPIO
rw  # Navigate to robot workspace
```

## 📚 Documentation

- [Ansible Roles](ansible/roles/ros2/README.md)
- [Playbook Usage](ansible/playbooks/README.md)
- [GitHub Actions Workflow](.github/workflows/build-iso.yml)

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Test changes (`make test-ansible`)
4. Commit changes (`git commit -m 'Add amazing feature'`)
5. Push to branch (`git push origin feature/amazing-feature`)
6. Open Pull Request

## 📋 Requirements

### Build Environment

- Ubuntu 20.04+ or similar Linux distribution
- 20GB+ free disk space
- Internet connection for package downloads
- sudo privileges

### Runtime (Generated ISOs)

- **AMD64**: Any x86_64 PC with 4GB+ RAM
- **ARM64**: Raspberry Pi 5 with 4GB+ RAM
- 16GB+ storage (SD card/USB/SSD)

## 🐛 Troubleshooting

### Common Issues

**Build fails with permission errors:**

```bash
sudo chmod 777 /tmp/iso-build /tmp/iso-output
```

**QEMU emulation issues:**

```bash
sudo update-binfmts --enable qemu-aarch64
```

**Network issues in chroot:**

```bash
# Check DNS resolution
cat /etc/resolv.conf
```

### Debug Mode

Enable verbose output:

```bash
make build-dev VERBOSE=1
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [ROS2 Community](https://ros.org/) for the excellent robotics framework
- [Ubuntu](https://ubuntu.com/) for the solid foundation
- [Ansible](https://ansible.com/) for infrastructure automation
