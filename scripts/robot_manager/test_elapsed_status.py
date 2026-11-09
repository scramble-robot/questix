"""Fractional elapsed status is additive and keeps the integer API unchanged."""

import pytest

from robot_manager import lab, recorder


def test_recorder_elapsed_uses_one_fractional_sample(monkeypatch, tmp_path):
    """The integer and millisecond fields describe the same instant."""
    monkeypatch.setattr(recorder, "_status_snapshot_locked", lambda: {
        "recording": True, "started_at": 100, "bag_path": tmp_path})
    monkeypatch.setattr(recorder, "_read_config_for_api", lambda: {"OUTPUT_DIR": str(tmp_path)})
    monkeypatch.setattr(recorder, "_disk_usage", lambda _: (100, 200))
    monkeypatch.setattr(recorder, "_tree_size", lambda _: 0)
    monkeypatch.setattr(recorder, "_min_free_bytes", lambda _: 0)
    monkeypatch.setattr(recorder.time, "time", lambda: 112.375)
    data = recorder._status_payload()
    assert data["elapsed_sec"] == 12
    assert data["elapsed_ms"] == pytest.approx(12375)


def test_lab_elapsed_resets_when_not_managed(monkeypatch):
    """Only a manager-owned bridge has an elapsed clock and a session start."""
    monkeypatch.setattr(lab, "_reap_locked", lambda: True)
    monkeypatch.setattr(lab, "_started_at", 100)
    monkeypatch.setattr(lab, "_read_config", lambda: {})
    monkeypatch.setattr(lab, "_permissions", lambda: {"ALLOW_DRIVE": False, "ALLOW_SHOOT": False})
    monkeypatch.setattr(lab, "_mode", lambda: "lesson")
    monkeypatch.setattr(lab, "_lab_available", lambda: True)
    monkeypatch.setattr(lab, "_competition_mode", lambda: False)
    monkeypatch.setattr(lab, "_lan_addresses", lambda: [])
    monkeypatch.setattr(lab, "_bridge_state", lambda: None)
    monkeypatch.setattr(lab, "_log_tail", lambda: None)
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    monkeypatch.setattr(lab.actuation, "running_mode", lambda: None)
    monkeypatch.setattr(lab.time, "time", lambda: 112.375)
    data = lab._status_payload()
    assert data["elapsed_sec"] == 12
    assert data["elapsed_ms"] == pytest.approx(12375)
    assert data["started_at"] == 100
    monkeypatch.setattr(lab, "_reap_locked", lambda: False)
    data = lab._status_payload()
    assert data["elapsed_sec"] == data["elapsed_ms"] == 0
    assert data["started_at"] is None
