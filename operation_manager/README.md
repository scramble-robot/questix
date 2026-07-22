# operation_manager

ROS2 package that subscribes to GPIO topics (published by `gpio_reader`) and decides whether GPIO IO is "controllable".

Publishers:
- `/gpio/controllable` (std_msgs/Bool): true if controllable
- `/diagnostics` (diagnostic_msgs/DiagnosticArray): standard diagnostic aggregation
  topic. One `DiagnosticStatus` (name `operation_manager: gpio_controllability`,
  hardware_id `gpio`) with `level` OK/ERROR and per-pin `KeyValue` entries
  (`pin_<N>_state`, `pin_<N>_age_sec`). Consumable by `rqt_runtime_monitor`.
- `/gpio/controllable_diagnostic` (std_msgs/String): **deprecated (#87)**, replaced
  by `/diagnostics`. Kept as a parallel free-text publish for one release, removed
  next release. See `questix_msgs/README.md` 移行メモ.
- `/emergency_stop` (questix_msgs/EmergencyStop, reliable + transient_local, keep-last(1)):
  unified emergency stop state, `active = !controllable`, published on every
  controllability evaluation (each GPIO update plus the 1 s timer heartbeat).
  See `questix_msgs/README.md` for the full topic contract and recovery semantics.

Parameters (config/operation_manager.yaml):
- `monitored_pins`: list of GPIO pin numbers to subscribe to (`gpio_<PIN>` topics)
- `timeout_seconds`: maximum allowed age of GPIO update before marking not controllable
- `emergency_stop_topic`: topic name for the unified emergency stop state (default `/emergency_stop`)

Build:
- colcon build --packages-select operation_manager

Run (with config):
- ros2 launch operation_manager operation_manager.launch.py
