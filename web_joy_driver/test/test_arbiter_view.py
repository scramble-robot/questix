"""command_arbiter's drive status as the page shows it (ROS-free)."""

import types

import pytest

from web_joy_driver.arbiter_view import STATUS_TIMEOUT_SEC, drive_view, fresh


def status(**fields):
    base = {"mechanism": "drive", "active_source": "lab", "switch_reason": "lab",
            "lab_locked": False}
    base.update(fields)
    return types.SimpleNamespace(**base)


def test_the_drive_status_becomes_the_pages_view():
    assert drive_view(status()) == {"active": "lab", "reason": "lab", "lab_locked": False}
    assert drive_view(status(active_source="joy", switch_reason="controller", lab_locked=True)) == {
        "active": "joy", "reason": "controller", "lab_locked": True}


def test_the_launchers_status_is_not_the_pages():
    assert drive_view(status(mechanism="launcher")) is None


def test_an_unknown_source_is_refused():
    with pytest.raises(ValueError):
        drive_view(status(active_source="autonomy"))


def test_a_silent_arbiter_is_forgotten():
    view = drive_view(status())
    assert fresh(view, 10.0, 10.0 + STATUS_TIMEOUT_SEC) == view
    assert fresh(view, 10.0, 10.0 + STATUS_TIMEOUT_SEC + 0.1) is None
    assert fresh(None, 10.0, 10.0) is None
    assert fresh(view, None, 10.0) is None
    copy = fresh(view, 10.0, 10.0)
    copy["active"] = "joy"
    assert view["active"] == "lab"  # the page gets a copy
