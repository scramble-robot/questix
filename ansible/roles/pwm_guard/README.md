# QUESTiX standard PWM guard deployment

The Pi 5 kit playbook runs this role for `questix_rp1_pwm` (Pi 5 model or Pi image
build). It stages **administrator-reviewed controller source**, hashes its paths
and contents into an isolated version directory, and invokes the protected
installer with `--yes --if-changed`. The installer takes its own bounded no-follow
snapshot, records its SHA-256 inventory and builds only guard/ctl, with a clean
environment and `/usr/bin/c++`. Deleted files from an older source cannot leak
into the new source directory. No Git config, hooks, ROS setup or student build
prefix is used by root. Ansible's inventory/playbook/controller source are the
administrator trust boundary: do not run an unreviewed student checkout with become.

The role copies the ordering-only `pwm-guard-order.conf`, enables the guard for the
next boot and does not start/restart it. Image builds use offline enable without
daemon reload. Existing ID13–16 installs need no removal: matching source, binaries
and unit skip rebuild; a missing/altered binary or unit is repaired. Legacy
`50-rp1-pwm.conf` still refuses deployment and frozen assets still warn. Updates
belong in an administrator-maintained, ESC-unpowered maintenance window; this
role neither grants students service authority nor bypasses the migration checks.

The separate hardware_interfaces role compiles the GPIO13-only overlay, keeps the
compiled master under `/etc/flash-kernel/dtbs/overlays`, copies it to firmware, and
appends an explicit `[all]` block. A reboot is needed for its application. Guard
readiness/waveform acceptance must be checked on every shipped robot.
