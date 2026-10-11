^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package questix_msgs
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Forthcoming
-----------
* feat!: add velocity_rpm_raw (the unfiltered wire value) to MotorFeedback,
  after velocity_rpm. Not compatible with 3.2.0: the type hash of MotorFeedback
  and of DriveStatus, which embeds it, changes, so nodes built from 3.2.0 and
  from this version do not interoperate on /drive_status, and bags recorded
  with 3.2.0 keep the old layout (read them with the 3.2.0 definitions).
  velocity_rpm itself is unchanged (low-pass filtered when
  measured_lpf_tau_sec > 0, as in 3.2.0)
* feat: add DriveControlSample and DriveControlWheelSample for the diagnostic
  per-control-tick topic /drive_control_sample (drive_component). They leave
  MotorFeedback and DriveStatus as they are (type hash and recorded-bag
  compatibility with the velocity_rpm_raw layout above)
* docs: /drive_status default rate is 50 Hz; note the 4096-step encoder behind
  position_raw
* Contributors: Yuichiroh Kobayashi

3.2.0 (2026-09-07)
------------------
* fix: integrate physical e-stop and competition auto-referee input (`#140 <https://github.com/scramble-robot/questix/issues/140>`_)
* Contributors: Yuichiroh Kobayashi

3.1.0 (2026-07-23)
------------------
* docs: document tuning-time ddt monitoring workflow (`#136 <https://github.com/scramble-robot/questix/issues/136>`_)
* Contributors: Akihisa Nagata

3.0.0 (2026-07-23)
------------------
* refactor: remove deprecated string status topics and esc bool mirror (`#130 <https://github.com/scramble-robot/questix/issues/130>`_)
* Contributors: Akihisa Nagata

2.2.0 (2026-07-23)
------------------
* feat: add MotorFeedback and DriveStatus messages for the typed status-topic
  migration (`#87 <https://github.com/scramble-robot/questix/issues/87>`_)
* Contributors: Akihisa Nagata

2.1.0 (2026-07-23)
------------------
* feat: add questix_msgs package with EmergencyStop message for the unified
  /emergency_stop topic (`#81 <https://github.com/scramble-robot/questix/issues/81>`_)
* Contributors: Akihisa Nagata
