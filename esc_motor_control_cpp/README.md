# QUESTiX ESC roller control

`esc_motor_control` follows `/launcher_command` (`questix_msgs/LauncherCommand`) and
the shared `/motion_permission` and `/emergency_stop` gates. A held nonzero command
cannot start the roller at startup or after a stop, timeout or multiple publishers:
a zero command is needed first. Input selection and the lesson permission remain in
command_arbiter; this node has no `/joy` or separate LAB input.

## PWM diagnostics and the opt-in RP1 backend

The default `pwm_backend: auto` remains the legacy backend selection. Explicit
`rp1_hw` uses the independent `questix_pwm_guard` on GPIO13. Missing guard, invalid
settings or failed ARM cause initialization failure, with no simulation fallback.
Its lease is renewed by the ROS executor every 100 ms after rechecking command
timeout, publishers, motion permission, E-stop and the PWM fault. Shutdown has an
800 ms budget. See [guard installation and failure contracts](../questix_pwm_guard/README.md).

`PwmCommand` records API-accepted pulses separately from the requested speed. A
failed send latches `pwm_fault` until node restart and blocks all nonzero commands.
A legacy neutral failure retries once, then stops pulses and requests Low. Failed
initial neutral never reports ready. Cleanup stops pulses, requests Low, then
closes the backend. A terminal Low never emits another neutral.

`/roller/status` preserves main's `command`, `source`, `estop`, `permission` and
`max_power`, and adds `pwm_fault`, `applied_pulse_us`, `pwm_backend`,
`pwm_output_state`, `pwm_error`. These are diagnostic API results, not a physical
waveform measurement. No old `lab_accepted`, `lab_locked` or teacher authority
fields are restored.

Software tests cover the real adapter with a fake guard, executor silence,
fault retry/terminal behavior, lgpio cleanup with fake functions, and the command
and safety gates. Real Pi 5 waveform and ESC validation remain separate.
