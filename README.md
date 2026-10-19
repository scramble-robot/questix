# QUESTiX — Robot Setup and Local Image Builder

🤖 **ROS 2 robot setup and local Ubuntu Desktop image generation for Raspberry Pi 5**

QUESTiX publishes setup and image-generation scripts. Each user obtains an official Ubuntu
Desktop image and generates their own Pi 5 SD image locally; this repository does not
build, validate or distribute completed OS images through GitHub Actions.
See [Pi Desktop イメージ生成ガイド](scripts/iso/README.md).

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
   ./setup_dev.sh
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

   - Use Raspberry Pi Imager (or similar) to flash Ubuntu 24.04 Desktop for Raspberry Pi (arm64)
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
   ./setup.sh
   ```

   This runs `ansible-playbook ansible/playbooks/setup_kit.yaml` locally and
   installs ROS 2 Jazzy, enables GPIO/I2C/SPI, applies udev rules, and
   builds the QUESTiX workspace (the checkout, e.g. `~/questix`: `dependency.repos`
   imported into `src/`, rosdep, `colcon build --symlink-install`).
   It reports the setup as completed only after the QUESTiX packages resolve.

   For an existing teaching SD, keep the existing OS/kernel/ROS package versions from
   being upgraded together during migration:

   ```bash
   ./setup.sh -e questix_os_upgrade=false
   # A checkout from before the executable-mode fix can use:
   # bash ./setup.sh -e questix_os_upgrade=false
   ```

   `questix_os_upgrade` defaults to `true` (the previous behavior). `false` disables
   only the role's `apt upgrade: dist`; apt cache refresh and required package
   installation still occur. This is not a package-version pin or a rollback.
   Both setup entry scripts forward extra Ansible arguments.

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
│   └── ansible-check.yaml # Setup-script checks (no OS image build)
├── ansible/              # Ansible automation
│   ├── roles/ros2/       # ROS2 installation role
│   └── playbooks/        # Environment setup playbooks
├── scripts/              # Local image recipes and robot management
│   ├── build-pi-image.sh  # Pi Desktop .img.xz
│   ├── iso/README.md      # Local generation and validation
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

## 🍓 Generate a Pi Desktop image locally

The base is the official Ubuntu 24.04 **preinstalled Desktop for Raspberry Pi**
`.img.xz`, pinned by filename and SHA-256 in `scripts/iso/pi-desktop-base.env`.
It retains the FAT boot + ext4 root partitions. Generic ARM64 ISO and Server
images are not accepted. The output includes ROS 2 Jazzy and a built QUESTiX workspace.

After obtaining the official base and installing the host tools described in the
[イメージ生成ガイド](scripts/iso/README.md):

```bash
make test-pi-image
make build-kit BASE_IMAGE=/absolute/path/to/official-desktop.img.xz
```

Add `IMAGE_USER=robot` to choose the login/service account (default: `ubuntu`).
The password is set by the user at first boot; there is no build-time password option.

The second command is a privileged, networked local build: it mounts a scratch
image and installs packages inside it. It does not write to an SD card. Results
are under `output/pi/`; select the generated `.img.xz` with Raspberry Pi Imager's
**Use custom** option. First boot needs a monitor and keyboard.

There is no image build/validation/upload/release workflow on GitHub Actions.
The existing AMD64 ISO scripts remain a separate legacy local path; they do not
produce Pi images, and their installer path is not validated by this change.
The Pi image's actual boot, desktop and hardware still require Pi 5 validation.

### First boot of a custom image

A QUESTiX custom image has **no initial password** and no passwordless sudo rule:

1. The selected account (default: `ubuntu`) is locked and SSH is disabled.
2. On the first boot, the console (tty1, a screen and keyboard) asks for a new password for that account
   (`questix-first-boot.service`, `scripts/iso/questix-first-boot-enroll.sh`).
3. Once it is set, SSH is enabled and the normal login starts. `sudo` asks for that password.
4. If the enrollment fails or is interrupted, the account stays locked, SSH stays disabled,
   and the next boot asks again.

The image is built from the checkout that runs `scripts/apply-ansible-config.sh`:
- That commit is cloned to `/home/<user>/questix` (tracked files only, owned by the selected user).
- The workspace is built there by that user (`questix_image_build=true`), so the first boot needs no download.
- The build fails if the finished tree breaks the first-enrollment policy (`scripts/iso/image-build-lib.sh`).

Robots set up from an older image or installer: `scripts/update-robot-manager.sh`,
`scripts/install-robot-manager.sh` and the setup playbooks run `scripts/cleanup_legacy_privileges.py`.
- It removes the legacy polkit `.pkla`.
- It removes the old image's `/etc/sudoers.d/ubuntu` only when the file is exactly that rule and the
  user has a safe password.
- While `ubuntu` still has the old known password `ubuntu`, it stops with exit 2 and asks for
  `sudo passwd ubuntu`. The update, the installer and the setup stop there too.
- It exits 0 when clean, 1 when a real run would remove something, and 2 when an operator has to act.

## 🧪 Testing

### Local Testing

```bash
# Validate Ansible
make test-ansible

# Check the local Pi image recipe (no root or image build)
make test-pi-image

# Legacy AMD64 ISO only (requires QEMU; does not validate Pi boot)
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
- [Pi Desktop イメージ生成ガイド](scripts/iso/README.md)

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
- About 40 GiB free disk space for the Pi Desktop image build
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

### Runtime (Locally Generated Images)

- **AMD64**: Any x86_64 PC with 4GB+ RAM
- **ARM64**: Raspberry Pi 5 with 4GB+ RAM
- Pi Desktop image: 32 GB+ SD card / SSD (default raw image: 24 GiB)

## 🐛 Troubleshooting

### Common Issues

**Pi image build fails:**

See [イメージ生成・復旧ガイド](scripts/iso/README.md). The script reports
its private scratch directory and any loop device that could not be detached.
Do not delete a directory while it still contains mounted filesystems.

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

QUESTiX のコードには [リポジトリのライセンス](LICENSE) が適用されます。
同梱ソフトウェアにはそれぞれの利用条件があります。生成したイメージを外部へ提供する場合は、
[生成ガイドの利用・配布について](scripts/iso/README.md#licenses-and-distribution) を確認してください。

## 🙏 Acknowledgments

- [ROS2 Community](https://ros.org/) for the excellent robotics framework
- [Ubuntu](https://ubuntu.com/) for the solid foundation
- [Ansible](https://ansible.com/) for infrastructure automation

## BlocklyによるQUESTiXシミュレーション

任意で起動できる `questix_blockly` パッケージで、前進・回転などをブロックから操作し、
ブラウザとRVizに同じ走行を表示できます。Blockly／ゲームコントローラーの切替に対応します。
既存の実機起動設定は変更しません。
ビルド・起動・対応範囲は [QUESTiX Blockly](questix_blockly/README.md) を参照してください。
