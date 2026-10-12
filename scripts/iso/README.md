# QUESTiX: local Raspberry Pi 5 Desktop image

QUESTiX publishes the generation recipe. Each user downloads the official Ubuntu
**Desktop** base and generates an image for their own use. There is no GitHub
Actions image build, validation, artifact upload or release job. The `.img.xz`
output is an SD/SSD disk image, not an installer ISO (issue #100).

The baseline is Ubuntu 24.04 + ROS 2 Jazzy. The exact base filename, URL and SHA-256
are pinned together in [pi-desktop-base.env](pi-desktop-base.env), currently
Ubuntu 24.04.5 `preinstalled-desktop-arm64+raspi.img.xz`. The digest was checked
against [Ubuntu's official SHA256SUMS](https://cdimage.ubuntu.com/releases/24.04/release/SHA256SUMS).
No Server image or generic ARM64 ISO is accepted, and no fallback download is used.
When the base changes, review its partition layout, Desktop/OEM startup and boot
files as well as its checksum, then repeat the hardware checks below.

## Build host

- Ubuntu 24.04 Linux, aarch64 or x86_64, with root access to loop devices and mount
  namespaces. Prefer a native ARM64 host for build speed; a Pi 5 also works.
- About 40 GiB of free disk space on the output filesystem, a network connection
  for package downloads, and enough RAM for the ROS workspace build.
- A committed QUESTiX checkout. The image contains **HEAD**, not local edits or
  the host's `build/`, `install/`, `src/` or credentials. Commit recipe changes
  before invoking a real build. The output records the commit identity.
- WSL/containers may lack the required kernel support. Use a Linux VM or native
  Linux if loop devices, binfmt or mount namespaces are unavailable. The old
  experimental Docker recipe is not the Pi Desktop build environment.

Install host tools explicitly (this changes the host, not just an image):

```bash
make setup-pi-image-deps
```

For an **x86_64** host, also install and enable ARM64 userspace emulation:

```bash
sudo apt-get install -y qemu-user-static binfmt-support
sudo update-binfmts --enable qemu-aarch64
cat /proc/sys/fs/binfmt_misc/qemu-aarch64
```

The registration must say `enabled` and contain `F` in its flags. The builder
checks it and never changes the host's binfmt registration itself. This emulates
userspace for chroot provisioning; it is not a Pi hardware/boot test.

## Obtain the official base

Run from the repository root as your regular user. These commands download from
Ubuntu, not from a QUESTiX image release:

```bash
bash -e <<'DOWNLOAD'
. scripts/iso/pi-desktop-base.env
mkdir -p output/pi/base
cd output/pi/base
curl --fail --location --proto '=https' --proto-redir '=https' \
  --output "$PI_BASE_FILE.part" "$PI_BASE_URL"
printf '%s  %s\n' "$PI_BASE_SHA256" "$PI_BASE_FILE.part" | sha256sum --check -
mv "$PI_BASE_FILE.part" "$PI_BASE_FILE"
DOWNLOAD
```

The builder independently checks the pinned digest **before decompression or
mounting**. Do not replace the expected digest with the digest of an untrusted
download. For independent signature verification, follow
[Ubuntu's verification guide](https://ubuntu.com/tutorials/how-to-verify-ubuntu).

## Generate locally

Optional checks below are offline and unprivileged; they create small fixture
files only, never mount filesystems or execute the image build:

```bash
make test-pi-image
```

Then build (root mounts a scratch image; package installation happens in chroot):

```bash
. scripts/iso/pi-desktop-base.env
make build-kit BASE_IMAGE="$PWD/output/pi/base/$PI_BASE_FILE"
```

Equivalent direct invocation:

```bash
sudo bash scripts/build-pi-image.sh \
  "$PWD/output/pi/base/$PI_BASE_FILE" "$PWD/output/pi"
```

No SD device argument is accepted. The original `.img.xz` remains unchanged.
Each build expands it to a new private scratch file, verifies the two-partition
layout (FAT `system-boot`, ext4 `writable`), expands the final root partition,
and mounts both partitions in a private mount namespace. The shared Ansible
image provisioner builds `/home/ubuntu/questix` as `ubuntu` and configures Robot
Manager without starting robot services in the build host.

The official firmware, kernel/initramfs settings and `root=` identity are
preserved. The existing `hardware_interfaces` role enables I2C/SPI/UART and
removes the serial-console argument so the controller can use UART. The builder
does not replace `config.txt`/`cmdline.txt`, overclock the Pi or force GPIOs high.

Ubuntu's OEM user creation is disabled, the temporary `oem` account is removed,
and cloud-init is disabled so it cannot overwrite account/SSH settings at boot.
GNOME and the Pi Desktop packages remain installed; the default target is
`graphical.target`. QUESTiX's existing console password enrollment runs before
the graphical login. Accounts have no baked-in password, autologin is off, and
SSH is disabled until enrollment succeeds. Locale, keyboard, timezone and
network preferences can subsequently be changed in GNOME Settings.

The default raw size is **24 GiB**; use an SD card/SSD of at least **32 GB**.
For a larger local build, set `QUESTIX_PI_SIZE_GIB` on the direct sudo invocation
(16–256 GiB is accepted, and the size must exceed the base image):

```bash
sudo env QUESTIX_PI_SIZE_GIB=40 bash scripts/build-pi-image.sh \
  "$PWD/output/pi/base/$PI_BASE_FILE" "$PWD/output/pi"
```

All mounts and the loop device must be released successfully before compression.
The output directory is created only after packaging succeeds and contains:

- `questix-pi5-desktop-ubuntu<version>-ros2jazzy-<commit>.img.xz`
- `SHA256SUMS` for the image and metadata
- `build-info.txt`: official base URL/digest, QUESTiX commit, build time and size
- `packages.tsv`: installed binary/source package versions and architectures
- `package-copyrights.tar.gz`: copies of package copyright/license notices
- Original and final `config.txt`/`cmdline.txt` for comparing boot configuration

The base and QUESTiX commit are pinned; apt/pip packages and external workspace
repositories can still change over time. This is not a bit-for-bit reproducible
build. Check the recorded package versions when comparing builds. An existing
result directory is never overwritten; choose another output directory to rebuild
the same commit. `PI_OUTPUT_DIR=/path/to/output` overrides the Make target's output.

## Write and validate on Pi 5

1. In the result directory, run `sha256sum --check SHA256SUMS`.
2. In Raspberry Pi Imager choose **Use custom**, select the generated `.img.xz`,
   and select your SD/SSD carefully. Writing erases that selected device. Do not
   apply Imager account/SSH customization; QUESTiX manages first enrollment.
3. Boot a Pi 5 with a monitor and keyboard. At tty1, set the `ubuntu` password.
   Then log into the Ubuntu Desktop. SSH becomes available only after enrollment.
4. Confirm Desktop login, networking, Robot Manager, `/home/ubuntu/questix` and
   ROS 2 Jazzy. Check the resulting root filesystem capacity and reboot once.
5. With the robot in a safe test setup, validate GPIO5/GPIO27 E-stop, UART
   controller input, I2C/SPI devices, mode selection and service startup. Confirm
   that the robot does not move before the required permissions and safety inputs.

The script and fixture tests cannot establish those hardware results. Until these
checks have been performed on a Raspberry Pi 5, issue #100's hardware acceptance
condition remains unverified. The legacy local AMD64 ISO scripts are separate
and are not a Pi boot test or a validated Desktop installer path.

## Failed builds

Errors and INT/TERM trigger cleanup in reverse mount order. There is no lazy or
forced unmount. The failed scratch image is retained in the reported
`.questix-pi-build.*` directory; a failed build never produces a finished result.

If unmount/detach fails, the error reports the loop device. Investigate mounts
and any process still using that scratch tree before cleanup; **do not delete a
mounted directory**. The builder's namespace disappears on exit, but processes
holding the filesystem may still require operator attention. Do not run the
legacy `make clean` as a way to recover a mounted Pi image. Retry from the
original verified base, not from the partially provisioned scratch image.

## Licenses and distribution

The scripts and QUESTiX code use the repository's [MIT license](../../LICENSE).
Ubuntu packages, ROS, firmware and third-party assets retain their own licenses;
the image as a whole is not MIT. Copyright files are retained in the image, and
the accompanying inventory/notices are for traceability, **not a complete source
offer or a declaration of redistribution compliance**.

This workflow distributes the recipe and asks each user to obtain Ubuntu from
its official site and generate an image for personal/internal use. It does not
upload the generated image. Passing the result to another organisation, posting
it for download or shipping preloaded SD cards is a separate distribution decision:
review the included licenses, corresponding-source obligations, firmware terms
and [Canonical's intellectual property policy](https://canonical.com/legal/intellectual-property-policy).
Generating from an official base does not remove those obligations.
