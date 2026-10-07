"""modes.py is the one list of modes: the UI and the mode API repeat it."""

import re
from pathlib import Path

from robot_manager import app, modes

STATIC = Path(__file__).resolve().parent / "static"


def test_three_modes_and_what_each_uses():
    assert modes.MODES == ("lesson", "practice", "competition")
    assert modes.DEFAULT == "practice"
    assert [mode for mode in modes.MODES if modes.uses_lab(mode)] == ["lesson"]
    assert [mode for mode in modes.MODES if modes.uses_teacher_permission(mode)] == ["lesson"]
    assert set(modes.STARTED_ON_REQUEST) == {"lesson", "practice"}
    assert set(modes.NAMES) == set(modes.LABELS) == set(modes.MODES)


def test_a_missing_or_unreadable_mode_file_means_practice(tmp_path):
    assert modes.read(tmp_path / "missing") == "practice"
    (tmp_path / "mode").write_text(" lesson \n")
    assert modes.read(tmp_path / "mode") == "lesson"


def test_the_mode_api_accepts_exactly_the_modes():
    assert set(app.ModeRequest.model_fields["mode"].annotation.__args__) == set(modes.MODES)


def test_the_ui_offers_exactly_the_modes():
    html = (STATIC / "index.html").read_text()
    choice = html[html.index('id="mode-choice"'):html.index("</fieldset>")]
    assert re.findall(r'name="mode" value="([a-z]+)"', choice) == list(modes.MODES)
    status_view = (STATIC / "status-view.js").read_text()
    names = dict(re.findall(r"(\w+): '([^']+)'",
                            re.search(r"const MODE = \{([^}]*)\}", status_view).group(1)))
    assert names == {mode: modes.NAMES[mode].removesuffix("用") for mode in modes.MODES}
