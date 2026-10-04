"""Tests for the 管理設定 launch settings (PUT /api/launch-config and its UI).

Issue #168: the GPIO5 physical E-stop is not an operating setting. Robot Manager must not offer a
switch for it, must not persist ENABLE_GPIO_REF=false, and migrates a legacy false on save
(test_launcher_script.py checks that the production launcher ignores the key anyway).
"""

import importlib
import logging
from pathlib import Path

import pytest
from pydantic import ValidationError

STATIC = Path(__file__).resolve().parent / "static"

EDITABLE = {
    "ENABLE_LIDAR": "true",
    "ENABLE_SHOT": "true",
    "ENABLE_DRIVE": "true",
    "ENABLE_RVIZ": "true",
    "CONTROLLER_TYPE": "uart",
    "ROS_DOMAIN_ID": "7",
    "ROBOT_WS": "/home/robot/robot_ws",
}

FRESH = (
    "ROS_DISTRO=jazzy\nROBOT_WS=/home/ubuntu/robot_ws\nROS_DOMAIN_ID=42\n"
    "ENABLE_LIDAR=false\nENABLE_SHOT=false\nENABLE_DRIVE=false\nENABLE_GPIO_REF={gpio}\n"
    "ENABLE_RVIZ=false\nCONTROLLER_TYPE=dualshock\n"
)


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    from robot_manager import app as module
    return importlib.reload(module)


def saved(app):
    return app._read_env()


def put(app, **fields):
    """PUT /api/launch-config: FastAPI answers 422 for a body LaunchConfig refuses."""
    return app.set_launch_config(app.LaunchConfig(**fields))


def test_editable_settings_are_saved(app):
    app.ENV_FILE.write_text(FRESH.format(gpio="true"))
    put(app, **EDITABLE)
    env = saved(app)
    for key, value in EDITABLE.items():
        assert env[key] == value, key
    assert env["ENABLE_GPIO_REF"] == "true"
    assert env["ROS_DISTRO"] == "jazzy"  # keys the form does not edit are kept


@pytest.mark.parametrize("value", ["false", "0", "no", ""])
def test_gpio_safety_cannot_be_switched_off(app, value):
    app.ENV_FILE.write_text(FRESH.format(gpio="true"))
    before = app.ENV_FILE.read_text()
    with pytest.raises(ValidationError, match="ENABLE_GPIO_REF cannot be turned off"):
        put(app, **EDITABLE, ENABLE_GPIO_REF=value)
    assert app.ENV_FILE.read_text() == before  # nothing else is saved either


def test_true_from_an_older_cached_page_is_still_accepted(app):
    app.ENV_FILE.write_text(FRESH.format(gpio="true"))
    put(app, **EDITABLE, ENABLE_GPIO_REF="true")
    assert saved(app)["ENABLE_GPIO_REF"] == "true"


def test_a_legacy_false_stays_visible_until_the_next_save_migrates_it(app, caplog):
    app.ENV_FILE.write_text(FRESH.format(gpio="false"))
    # Reported as it is: the operator can see what the file says.
    assert app.get_launch_config()["ENABLE_GPIO_REF"] == "false"
    with caplog.at_level(logging.INFO, logger=app.logger.name):
        answer = put(app, ENABLE_DRIVE="true")
    assert answer["ENABLE_GPIO_REF"] == "true"
    env = saved(app)
    assert env["ENABLE_GPIO_REF"] == "true" and env["ENABLE_DRIVE"] == "true"
    assert app.get_launch_config()["ENABLE_GPIO_REF"] == "true"
    messages = [record.getMessage() for record in caplog.records]
    assert "launch-config updated: ENABLE_GPIO_REF false -> true" in messages
    assert "launch-config updated: ENABLE_DRIVE false -> true" in messages


def test_a_save_never_creates_enable_gpio_ref_false(app):
    app.ENV_FILE.write_text("ROS_DOMAIN_ID=42\n")  # no ENABLE_GPIO_REF: the launcher default
    put(app, **EDITABLE)
    assert saved(app).get("ENABLE_GPIO_REF") != "false"


def test_only_changed_keys_are_logged(app, caplog):
    app.ENV_FILE.write_text(FRESH.format(gpio="true"))
    with caplog.at_level(logging.INFO, logger=app.logger.name):
        put(app, ENABLE_SHOT="false", ENABLE_LIDAR="true", ROS_DOMAIN_ID="8")
    messages = [record.getMessage() for record in caplog.records
                if record.getMessage().startswith("launch-config updated")]
    assert messages == ["launch-config updated: ENABLE_LIDAR false -> true",
                        "launch-config updated: ROS_DOMAIN_ID 42 -> 8"]
    # Recorded at WARNING so it reaches the journal under uvicorn's default logging.
    assert all(record.levelno == logging.WARNING for record in caplog.records
               if record.getMessage().startswith("launch-config updated"))


def test_the_settings_page_has_no_gpio_safety_switch():
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert 'data-config="ENABLE_GPIO_REF"' not in html
    assert '"ENABLE_GPIO_REF"' not in script
    # It is shown as always on instead.
    assert 'id="gpio-safety-fixed"' in html
    # The other settings keep their inputs.
    for key in ("ENABLE_LIDAR", "ENABLE_SHOT", "ENABLE_DRIVE", "ENABLE_RVIZ", "CONTROLLER_TYPE"):
        assert f'data-config="{key}"' in html, key
    for element in ('id="ros-domain-id"', 'id="robot-ws"', 'id="save-config"'):
        assert element in html, element
