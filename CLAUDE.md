@AGENTS.md

## Claude Code

- Treat `AGENTS.md` as the primary project guidance.
- Keep this file as a Claude-specific adapter, not a duplicate manual.
- Use a plan/review-oriented workflow before broad edits.
- Prefer small, reviewable changes with clear validation notes.
<!-- Claude-specific emphasis: repeated from AGENTS.md to ensure these constraints are applied by Claude Code -->
- Do not run ISO builds, QEMU tests, package installation, permission changes, systemd commands, or hardware-facing commands unless explicitly requested.
- For GPIO, UART, I2C, SPI, systemd, robot startup, and controller integration, treat Raspberry Pi 5 hardware validation as authoritative.
