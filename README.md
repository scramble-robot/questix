# ROS2 Robotics Kit - Automated ISO Builder

🤖 **Automated Ubuntu ISO builder with pre-configured ROS2 environment for robotics development**

This project provides a complete automation pipeline using Ansible and GitHub Actions to create custom Ubuntu ISO images with ROS2 and robotics development tools pre-installed.

## 🎯 Features

### 🖥️ Development Environment (AMD64)

- **Target**: Desktop/laptop development machines
- **OS**: Ubuntu 24.04 LTS with ROS2 Jazzy
- **Tools**: Full desktop environment, development tools, ROS2 Desktop
- **Workspace**: Shell aliases pre-configured for `~/ros2_ws`

### 🍓 Robotics Kit (ARM64 - Raspberry Pi 5)

- **Target**: Raspberry Pi 5 robotics projects
- **OS**: Ubuntu 24.04 LTS with ROS2 Jazzy
- **Hardware**: GPIO, I2C, SPI interfaces pre-configured
- **Tools**: Robotics libraries, hardware abstraction layers
- **Workspace**: Pre-configured `~/robot_ws`

## 🚀 Quick Start

There are two local setup paths: run the AMD64 playbook on the development
machine and run the ARM64 kit playbook on the Raspberry Pi 5 itself.

### 1. AMD64 Development Machine (local provisioning)

On an x86_64 machine running Ubuntu 24.04, run Ansible against `localhost`.

1. **Install prerequisites**

   ```bash
   sudo apt update
   sudo apt install -y git ansible python3-vcstool
   ```

2. **Clone the repository**

   ```bash
   git clone https://github.com/scramble-robot/questix.git
   cd questix
   ```

3. **Run the setup script (AMD64)**

   ```bash
   bash setup_dev.sh
   ```

   This installs ROS 2 Jazzy Desktop, colcon, developer tooling, and configures
   shell aliases for `~/ros2_ws`.

4. **Fetch workspace dependencies and build**

   ```bash
   mkdir -p ~/ros2_ws/src
   vcs import ~/ros2_ws/src < dependency.repos
   cd ~/ros2_ws
   source /opt/ros/jazzy/setup.bash
   rosdep update
   rosdep install --from-paths . src --ignore-src -r -y
   colcon build --symlink-install
   source install/setup.bash
   ```

   `rosdep install` resolves workspace package dependencies declared in
   `package.xml` files. In the current tree, this includes packages such as
   `libgpiod-dev`, `joint_state_publisher`, and `xacro`.

5. **Verify**

   ```bash
   ros2 -h
   printenv ROS_DISTRO
   ros2 topic list
   ```

   `ros2 --version` is not used here because the ROS 2 CLI does not accept that
   option in this environment.

### 2. Raspberry Pi 5 (ARM64) Setup (run on the Pi itself)

Flash Ubuntu 24.04 (64-bit) onto the Raspberry Pi 5 and boot it. The setup is
performed **on the Pi itself** by running the bundled `setup.sh`, which invokes
the kit playbook against `localhost`.

1. **Prepare the Raspberry Pi 5**

   - Use Raspberry Pi Imager (or similar) to flash Ubuntu 24.04 Server (arm64)
     to the microSD card / SSD.
   - On first boot, create a user and connect to the network.

2. **Install Git and Ansible on the Pi**

   ```bash
   sudo apt update
   sudo apt install -y git ansible
   ```

3. **Clone the repository on the Pi**

   ```bash
   git clone https://github.com/scramble-robot/questix.git
   cd questix
   ```

4. **Run the setup script**

   ```bash
   bash setup.sh
   ```

   This runs `ansible-playbook ansible/playbooks/setup_kit.yaml` locally and
   installs ROS 2 Jazzy, enables GPIO/I2C/SPI, applies udev rules, and
   builds the QUESTiX workspace (the checkout, e.g. `~/questix`: `dependency.repos`
   imported into `src/`, rosdep, `colcon build --symlink-install`).
   It reports the setup as completed only after the QUESTiX packages resolve.

5. **Reboot and verify**

   ```bash
   sudo reboot
   # After logging back in:
   source ~/.bashrc
   ros2 --version
   gpio_status   # list the GPIO lines (read-only, gpiochip4)
   rw   # cd into the workspace
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

The default build target is Ubuntu 24.04 + ROS 2 Jazzy. Normal builds do not require
setting `ROS2_DISTRO` or `UBUNTU_VERSION`.

```bash
# Advanced: override only the architecture when calling the internal target directly
make _build ARCHITECTURE=amd64
```

### Ansible Playbooks

Modify the Ansible playbooks in `ansible/playbooks/`:

- `setup_dev.yaml` - Development environment
- `setup_kit.yaml` - Robotics kit environment

### Additional Packages

Add packages to the `ros2_additional_packages` variable in playbooks:

```yaml
ros2_additional_packages:
  - ros-jazzy-navigation2
  - ros-jazzy-slam-toolbox
  - ros-jazzy-moveit
```

## 🐙 GitHub Actions

### Automated Builds

The ISO build workflow is manual-only and runs when manually dispatched via GitHub Actions.
When started, it:

1. 🏗️ Builds Ubuntu 24.04 + ROS 2 Jazzy ISOs for AMD64 and ARM64
2. 🧪 Tests the AMD64 ISO boot path in QEMU
3. 📦 Uploads ISO artifacts
4. 🔐 Generates checksums

Baseline upgrade note: the current workflow builds Ubuntu 24.04 + ROS 2 Jazzy
for both AMD64 and ARM64. A future move to Ubuntu 26.04 + ROS 2 Lyrical should
update the workflow matrix, ISO artifact names, release notes, dependency
compatibility notes, and this README together. This PR does not change the
baseline to Lyrical.

The release job is present but disabled; manual dispatch does not publish GitHub releases.

### First boot of a custom image

A QUESTiX custom image has **no initial password** and no passwordless sudo rule:

1. The `ubuntu` account is locked and SSH is disabled.
2. On the first boot, the console (tty1, a screen and keyboard) asks for a new password for `ubuntu`
   (`questix-first-boot.service`, `scripts/iso/questix-first-boot-enroll.sh`).
3. Once it is set, SSH is enabled and the normal login starts. `sudo` asks for that password.
4. If the enrollment fails or is interrupted, the account stays locked, SSH stays disabled,
   and the next boot asks again.

The image is built from the checkout that runs `scripts/apply-ansible-config.sh`:
- That commit is cloned to `/home/ubuntu/questix` (tracked files only, owned by `ubuntu`).
- The workspace is built there by `ubuntu` (`questix_image_build=true`), so the first boot needs no download.
- The build fails if the finished tree breaks the first-enrollment policy (`scripts/iso/image-build-lib.sh`).

Robots set up from an older image or installer: `scripts/update-robot-manager.sh`,
`scripts/install-robot-manager.sh` and the setup playbooks run `scripts/cleanup_legacy_privileges.py`.
- It removes the legacy polkit `.pkla`.
- It removes the old image's `/etc/sudoers.d/ubuntu` only when the file is exactly that rule and the
  user has a safe password.
- While `ubuntu` still has the old known password `ubuntu`, it stops with exit 2 and asks for
  `sudo passwd ubuntu`. The update, the installer and the setup stop there too.
- It exits 0 when clean, 1 when a real run would remove something, and 2 when an operator has to act.

### Triggers

- **Manual dispatch**: Build and test ISO artifacts

### Manual Trigger

```bash
# Trigger manual build via GitHub CLI
gh workflow run build-iso.yml
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
gpio_status  # List GPIO lines (read-only, gpiochip4)
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

- Ubuntu 24.04 with ROS 2 Jazzy
- 20GB+ free disk space
- Internet connection for package downloads
- sudo privileges

### Workspace Build Dependencies

Required for building packages:

- `libgpiod-dev` - headers and libraries used by `gpio_reader`

Required when launching visualization or robot description flows:

- `ros-jazzy-xacro`
- `ros-jazzy-joint-state-publisher`

### Runtime Source Dependencies

The launcher package expects the following packages to be available in the same colcon
workspace. They are source/workspace dependencies, not apt packages:

- `ydlidar_ros2_driver`
- `esc_motor_control_cpp`
- `ddt_motor_control`

For Jazzy operation, confirm that each selected branch or tag in `dependency.repos`
is compatible with ROS 2 Jazzy before using it. A successful `vcs import` only
confirms that the repositories were fetched; it does not guarantee runtime behavior.

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

## BlocklyによるQUESTiXシミュレーション

任意で起動できる `questix_blockly` パッケージで、前進・回転などをブロックから操作し、
ブラウザとRVizに同じ走行を表示できます。Blockly／ゲームコントローラーの切替に対応します。
既存の実機起動設定は変更しません。
ビルド・起動・対応範囲は [QUESTiX Blockly](questix_blockly/README.md) を参照してください。
