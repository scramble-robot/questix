"""Readiness contracts using temporary paths and mocked service/ROS/permissions."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Response

from robot_manager import recorder, recorder_readiness as module, trial


@pytest.fixture
def wired(tmp_path, monkeypatch):
    config = dict(recorder._DEFAULT_CONFIG, OUTPUT_DIR=str(tmp_path / "bags"), MIN_FREE_GB="0")
    manager = module.Readiness(Mock(return_value=module.Readiness.empty("pass", "確認済み")))
    manager.set_service_source(lambda: "active")
    monkeypatch.setattr(recorder, "readiness", manager)
    monkeypatch.setattr(recorder, "_read_config", lambda: config.copy())
    for name, value in {"_proc": None, "_starting": False, "_capturing": False}.items():
        monkeypatch.setattr(recorder, name, value)
    return config, manager


def payload():
    return recorder.get_readiness(Response())


def test_readiness_is_read_only_and_normal_does_not_query_ros(wired, monkeypatch):
    config, manager = wired
    monkeypatch.setattr(Path, "mkdir", Mock(side_effect=AssertionError("mkdir")))
    monkeypatch.setattr(Path, "write_text", Mock(side_effect=AssertionError("write")))
    response = Response()
    data = recorder.get_readiness(response)
    assert data["normal"]["ready"] and not data["trial"]["ready"]
    assert data["output"]["creatable"] and not Path(config["OUTPUT_DIR"]).exists()
    assert response.headers["Cache-Control"] == "no-store"
    manager.query.assert_not_called()


@pytest.mark.parametrize("state,code", [("inactive", 409), ("failed", 409),
                                       ("activating", 409), ("unknown", 503)])
@pytest.mark.parametrize("evidence", [False, True])
def test_stopped_start_creates_neither_folder_nor_process(wired, monkeypatch, state, code, evidence):
    config, manager = wired
    manager.set_service_source(lambda: state)
    prepare = Mock(side_effect=AssertionError("prepare"))
    popen = Mock(side_effect=AssertionError("Popen"))
    monkeypatch.setattr(recorder, "_prepare_output", prepare)
    monkeypatch.setattr(recorder.subprocess, "Popen", popen)
    with pytest.raises(HTTPException) as error:
        recorder._start_trial({}) if evidence else recorder.start_recording()
    assert error.value.status_code == code
    assert not Path(config["OUTPUT_DIR"]).exists()
    assert not recorder._starting
    prepare.assert_not_called()
    popen.assert_not_called()


@pytest.mark.parametrize("name", ["_starting", "_capturing", "_proc"])
def test_busy_states_block_start(wired, monkeypatch, name):
    monkeypatch.setattr(recorder, name, SimpleNamespace(poll=lambda: None) if name == "_proc" else True)
    assert "recorder_idle" in payload()["normal"]["blocker_codes"]


def test_stopping_lock_timeout_fails_closed(wired):
    started = time.monotonic()
    with recorder._lock:
        data = payload()
    assert 0.15 <= time.monotonic() - started < 1.0
    assert not data["normal"]["ready"] and not data["trial"]["ready"]
    assert data["common_checks"][0]["state"] == "unknown"


@pytest.mark.parametrize("free,ready", [(1024**3 - 1, False), (1024**3, True), (2 * 1024**3, True)])
def test_capacity_boundary(wired, monkeypatch, free, ready):
    config, _manager = wired
    config["MIN_FREE_GB"] = "1"
    monkeypatch.setattr(module.shutil, "disk_usage", lambda _p: SimpleNamespace(free=free))
    assert payload()["normal"]["ready"] is ready


@pytest.mark.parametrize("case", ["w", "x", "readonly", "file", "link", "capacity_error", "access_error"])
def test_unusable_storage_is_not_ready(wired, monkeypatch, case):
    config, _manager = wired
    path = Path(config["OUTPUT_DIR"])
    if case == "file":
        path.write_text("not a directory")
    elif case == "link":
        path.symlink_to(path.parent / "absent")
    elif case == "readonly":
        monkeypatch.setattr(module.os, "statvfs", lambda _p: SimpleNamespace(f_flag=module.os.ST_RDONLY))
        monkeypatch.setattr(module.shutil, "disk_usage", lambda _p: SimpleNamespace(free=1024**3))
    elif case == "capacity_error":
        monkeypatch.setattr(module.shutil, "disk_usage", Mock(side_effect=OSError("unavailable")))
    elif case == "access_error":
        monkeypatch.setattr(module.os, "access", Mock(side_effect=PermissionError()))
    else:
        original = module.os.access
        def access(p, mode, **kwargs):
            if case == "w" and mode & module.os.W_OK:
                return False
            if case == "x" and Path(p) == path.parent.parent:
                return False
            return original(p, mode, **kwargs)
        monkeypatch.setattr(module.os, "access", access)
    assert not payload()["normal"]["ready"]


@pytest.mark.parametrize("key,value", [("MIN_FREE_GB", "bad"), ("MIN_FREE_GB", "-1"),
                                      ("OUTPUT_DIR", "relative"), ("VEHICLE_NAME", "bad name")])
def test_invalid_settings_fail_closed(wired, key, value):
    wired[0][key] = value
    assert not payload()["normal"]["ready"]


def test_unreadable_settings_and_unknown_service(wired, monkeypatch):
    monkeypatch.setattr(recorder, "_read_config", Mock(side_effect=PermissionError()))
    wired[1].set_service_source(Mock(side_effect=OSError()))
    assert set(payload()["normal"]["blocker_codes"]) == {"robot_service", "config_unreadable"}


@pytest.fixture
def scheduler(monkeypatch):
    now = [0.0]
    workers = []
    timers = []
    class Thread:
        def __init__(self, target, args=(), **_kwargs):
            self.target, self.args = target, args
        def start(self):
            workers.append(self)
        def run(self):
            self.target(*self.args)
    class Timer(Thread):
        def __init__(self, delay, target):
            super().__init__(target)
            self.delay, self.cancelled = delay, False
        def start(self):
            timers.append(self)
        def cancel(self):
            self.cancelled = True
    monkeypatch.setattr(module.threading, "Thread", Thread)
    monkeypatch.setattr(module.threading, "Timer", Timer)
    query = Mock(return_value=module.Readiness.empty("pass", "確認済み"))
    manager = module.Readiness(query, clock=lambda: now[0])
    return manager, now, workers, timers


def test_single_worker_pending_latest_and_minimum_interval(scheduler):
    manager, now, workers, timers = scheduler
    manager.request()
    for _ in range(5):
        manager.request()
    assert len(workers) == 1
    workers.pop().run()
    assert len(timers) == 1 and timers[0].delay == 5
    now[0] = 5
    timers.pop().run()
    assert len(workers) == 1
    workers.pop().run()
    assert manager.query.call_count == 2


@pytest.mark.parametrize("trigger", ["service", "settings", "ttl"])
def test_three_invalidation_triggers_never_reuse_success(scheduler, trigger):
    manager, now, workers, _timers = scheduler
    manager.set_service_source(lambda: "active")
    manager.service()
    manager.request()
    workers.pop().run()
    assert manager.snapshot()[1]["state"] == "pass"
    if trigger == "service":
        manager.set_service_source(lambda: "inactive")
        manager.service()
    elif trigger == "settings":
        manager.invalidate()
    else:
        now[0] = 60
    generation, result = manager.snapshot()
    assert generation == 1 and result["state"] != "pass"
    assert manager.snapshot()[0] == generation
    assert manager.query.call_count == 1  # Expiry never starts another worker.


def test_old_worker_is_discarded_and_new_generation_waits(scheduler):
    manager, now, workers, _timers = scheduler
    manager.request()
    manager.invalidate()
    manager.request()
    assert len(workers) == 1
    now[0] = 5
    workers.pop().run()
    assert manager.snapshot()[1]["state"] == "checking"
    assert len(workers) == 1
    workers.pop().run()
    assert manager.snapshot()[1]["state"] == "pass"


def test_service_cache_and_start_bypass(scheduler):
    manager, now, _workers, _timers = scheduler
    source = Mock(side_effect=["active", "inactive", "unknown"])
    manager.set_service_source(source)
    assert manager.service() == manager.service() == "active"
    assert source.call_count == 1
    assert manager.service(fresh=True) == "inactive"
    now[0] = 1
    assert manager.service() == "unknown"


def test_refresh_does_not_inherit_previous_results_expiry(scheduler):
    manager, now, workers, _timers = scheduler
    manager.request()
    workers.pop().run()
    now[0] = 5
    manager.request()
    now[0] = 60
    assert manager.snapshot()[0] == 0
    assert manager.snapshot()[1]["state"] == "checking"
    workers.pop().run()
    assert manager.snapshot()[1]["state"] == "pass"


def test_budget_and_query_failure_are_bounded(scheduler):
    manager, now, workers, _timers = scheduler
    def query(timeout):
        assert timeout() == 15
        now[0] = 60
        timeout()
    manager.query = query
    manager.request()
    workers.pop().run()
    assert manager.snapshot()[1]["state"] == "error"
    assert not manager.running


def test_explicit_refresh_only_and_config_save_invalidates(wired, scheduler, monkeypatch):
    manager, _now, workers, _timers = scheduler
    manager.set_service_source(lambda: "active")
    monkeypatch.setattr(recorder, "readiness", manager)
    recorder.get_readiness(Response(), "normal", True)
    assert not workers
    recorder.get_readiness(Response(), "trial", True)
    assert len(workers) == 1
    workers.pop().run()
    assert payload()["trial"]["ready"]
    monkeypatch.setattr(recorder, "_write_config", Mock())
    recorder.set_config(recorder.RecorderConfig(MIN_FREE_GB="1"))
    assert manager.snapshot()[0] == 1
    assert not payload()["trial"]["ready"]


@pytest.mark.parametrize("missing", ["/drive_component", *trial.REQUIRED_TOPICS])
def test_graph_missing_reason_reuses_required_contract(wired, monkeypatch, missing):
    monkeypatch.setattr(recorder, "_read_env_file", lambda _p: {"ROBOT_WS": "/tmp/ws"})
    monkeypatch.setattr(module, "source_check", lambda *_args: None)
    def run(_runtime, argv, timeout):
        values = trial.REQUIRED_TOPICS if argv[1] == "topic" else trial.REQUIRED_NODES
        assert 0 < timeout <= 15
        return 0, "\n".join(v for v in values if v != missing), ""
    monkeypatch.setattr(trial, "run_ros", run)
    result = recorder._query_readiness_trial(lambda: 15)
    assert result["state"] == "fail" and result["missing_required"] == [missing]
    assert "起動の直後" in result["message"] and "開始条件を再確認" in result["message"]


def test_start_still_runs_original_trial_preflight(wired, monkeypatch):
    wired[1].result = module.Readiness.empty("pass", "cached")
    monkeypatch.setattr(recorder, "_prepare_output", lambda _c: ("robot", Path(wired[0]["OUTPUT_DIR"])))
    monkeypatch.setattr(recorder, "_read_env_file", lambda _p: {})
    monkeypatch.setattr(recorder, "_resolve_source_identity", lambda _r: {})
    fresh = Mock(side_effect=HTTPException(409, "必須のノードがありません"))
    monkeypatch.setattr(recorder, "_classroom_preflight", fresh)
    with pytest.raises(HTTPException) as error:
        recorder._start_trial({})
    assert error.value.status_code == 409
    fresh.assert_called_once()


@pytest.mark.parametrize("case", ["pass", "not_source", "bad_sha", "missing_git"])
def test_bounded_source_query_uses_existing_candidate_rules(monkeypatch, case):
    monkeypatch.setattr(trial, "source_candidates", lambda _ws: [(Path("/tmp/repo"), "robot_ws")])
    monkeypatch.setattr(trial, "is_questix_source", lambda _p: case != "not_source")
    def run(argv, **kwargs):
        assert kwargs["timeout"] == 7
        assert argv[:3] == ["git", "-C", "/tmp/repo"]
        if case == "missing_git":
            raise FileNotFoundError
        text = "/tmp/repo" if argv[-1] == "--show-toplevel" else "a" * 40
        return SimpleNamespace(returncode=0, stdout="bad" if case == "bad_sha" else text)
    monkeypatch.setattr(module.subprocess, "run", run)
    runtime = SimpleNamespace(robot_ws="/tmp/ws")
    if case == "pass":
        module.source_check(runtime, lambda: 7)
    else:
        with pytest.raises((HTTPException, FileNotFoundError)):
            module.source_check(runtime, lambda: 7)


def test_runtime_failure_has_specific_reason(wired, monkeypatch):
    monkeypatch.setattr(recorder, "_read_env_file", lambda _p: {"ROS_DOMAIN_ID": "bad"})
    with pytest.raises(HTTPException) as error:
        recorder._query_readiness_trial(lambda: 15)
    assert "ROS_DOMAIN_ID" in error.value.detail


def test_ros_failure_and_success_remain_read_only(wired, monkeypatch):
    monkeypatch.setattr(recorder, "_read_env_file", lambda _p: {})
    monkeypatch.setattr(module, "source_check", lambda *_args: None)
    calls = []
    def run(_runtime, argv, timeout):
        calls.append(argv)
        names = trial.REQUIRED_TOPICS if argv[1] == "topic" else trial.REQUIRED_NODES
        return 0, "\n".join(names), ""
    monkeypatch.setattr(trial, "run_ros", run)
    assert recorder._query_readiness_trial(lambda: 15)["state"] == "pass"
    assert calls == [["ros2", "topic", "list"], ["ros2", "node", "list"]]
    monkeypatch.setattr(trial, "run_ros", lambda *_args, **_kw: (124, "", "timeout"))
    with pytest.raises(HTTPException) as error:
        recorder._query_readiness_trial(lambda: 15)
    assert error.value.status_code == 503


@pytest.mark.parametrize("slow_helper", ["_read_config_for_api", "_disk_usage", "_tree_size"])
def test_slow_status_io_does_not_make_readiness_unknown(wired, monkeypatch, slow_helper):
    """Periodic status I/O must not block either readiness scope's state snapshot."""
    recording = slow_helper == "_tree_size"
    if recording:
        monkeypatch.setattr(recorder, "_proc", SimpleNamespace(poll=lambda: None))
        monkeypatch.setattr(recorder, "_bag_path", Path(wired[0]["OUTPUT_DIR"]) / "active")
    wired[1].result = module.Readiness.empty("pass", "確認済み")
    entered = threading.Event()
    original = getattr(recorder, slow_helper)
    def slow(*args):
        entered.set()
        time.sleep(0.5)
        return original(*args)
    monkeypatch.setattr(recorder, slow_helper, slow)
    with ThreadPoolExecutor(max_workers=3) as pool:
        for _ in range(5):
            entered.clear()
            status = pool.submit(recorder.get_status)
            assert entered.wait(2), "status never reached the slow I/O"
            checks = [pool.submit(recorder.get_readiness, Response(), scope)
                      for scope in ("normal", "trial")]
            for check in checks:
                data = check.result(timeout=3)
                assert data["common_checks"][0]["state"] == ("fail" if recording else "pass")
                assert data["normal"]["ready"] is not recording
                assert data["trial"]["ready"] is not recording
            assert status.result(timeout=3)["recording"] is recording


def test_short_state_lock_contention_is_waited_for(wired):
    """A short snapshot overlap should settle without an unknown response."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        with recorder._lock:
            answer = pool.submit(payload)
            time.sleep(0.05)
        assert answer.result(timeout=2)["common_checks"][0]["state"] == "pass"


@pytest.mark.parametrize("name,message", [
    ("_starting", "記録を開始しています"),
    ("_capturing", "停止処理・停止後の証拠を保存しています"),
    ("_proc", "記録中です"),
])
def test_busy_state_reasons_survive_snapshot_changes(wired, monkeypatch, name, message):
    monkeypatch.setattr(recorder, name, SimpleNamespace(poll=lambda: None) if name == "_proc" else True)
    data = payload()
    assert data["common_checks"][0] == {"code": "recorder_idle", "state": "fail", "message": message}
    assert not data["normal"]["ready"] and not data["trial"]["ready"]


def test_status_keeps_one_snapshot_while_storage_io_runs(wired, monkeypatch):
    """A state change during slow storage I/O must not mix two recordings' display fields."""
    entered, release = threading.Event(), threading.Event()
    bag = Path(wired[0]["OUTPUT_DIR"]) / "first"
    for name, value in {"_proc": SimpleNamespace(poll=lambda: None), "_bag_name": "first",
                        "_bag_path": bag, "_started_at": time.time() - 3,
                        "_mode": "generic", "_last_stop_reason": None,
                        "_last_trial": {"warnings": ["original"]}}.items():
        monkeypatch.setattr(recorder, name, value)
    tree_size = Mock(return_value=42)
    monkeypatch.setattr(recorder, "_tree_size", tree_size)
    def disk(_path):
        entered.set()
        assert release.wait(3)
        return 10, 20
    monkeypatch.setattr(recorder, "_disk_usage", disk)
    with ThreadPoolExecutor(max_workers=1) as pool:
        answer = pool.submit(recorder.get_status)
        try:
            assert entered.wait(2)
            with recorder._lock:
                recorder._proc = None
                recorder._bag_path = None
                recorder._bag_name = "second"
                recorder._started_at = None
                recorder._last_stop_reason = "stopped"
                recorder._last_trial["warnings"].append("later")
        finally:
            release.set()
        data = answer.result(timeout=3)
    assert data["recording"] and data["bag_name"] == "first" and data["mode"] == "generic"
    assert data["elapsed_sec"] >= 3 and data["size_bytes"] == 42
    assert data["last_stop_reason"] is None and data["last_trial"]["warnings"] == ["original"]
    tree_size.assert_called_once_with(bag)
