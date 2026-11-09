"""Recorder defaults, persisted overrides and split-bag directory operations."""

from html.parser import HTMLParser
from pathlib import Path

from robot_manager import recorder


class SplitInput(HTMLParser):
    """Read the recording form's split-size input."""

    def __init__(self):
        super().__init__()
        self.value = None

    def handle_starttag(self, tag, attrs):
        """Capture only the split-size field."""
        attrs = dict(attrs)
        if tag == 'input' and attrs.get('id') == 'rec-max-split':
            self.value = attrs.get('value')


def test_default_split_is_used_by_api_command_and_form(monkeypatch, tmp_path):
    monkeypatch.setattr(recorder, 'ROSBAG_ENV_FILE', tmp_path / 'absent.env')
    monkeypatch.setattr(recorder, 'LAUNCH_ENV_FILE', tmp_path / 'launch.env')
    config = recorder.get_config()
    assert config['MAX_SPLIT_MB'] == recorder._DEFAULT_CONFIG['MAX_SPLIT_MB']
    command = recorder._build_record_command(config, tmp_path / 'robot_run')
    assert f"--max-bag-size {int(recorder._DEFAULT_CONFIG['MAX_SPLIT_MB']) * 1000**2}" in command
    field = SplitInput()
    field.feed((Path(__file__).parent / 'static/index.html').read_text())
    assert field.value == config['MAX_SPLIT_MB']


def test_existing_split_setting_wins_including_disabled(monkeypatch, tmp_path):
    env = tmp_path / 'rosbag.env'
    monkeypatch.setattr(recorder, 'ROSBAG_ENV_FILE', env)
    for value in ('0', '128'):
        env.write_text(f'MAX_SPLIT_MB={value}\n')
        assert recorder.get_config()['MAX_SPLIT_MB'] == value


def test_split_bag_listing_size_and_delete(monkeypatch, tmp_path):
    env = tmp_path / 'rosbag.env'
    output = tmp_path / 'bags'
    output.mkdir()
    env.write_text(f'OUTPUT_DIR={output}\n')
    monkeypatch.setattr(recorder, 'ROSBAG_ENV_FILE', env)
    monkeypatch.setattr(recorder, '_proc', None)
    monkeypatch.setattr(recorder, '_bag_name', None)
    bag = output / 'robot_run'
    bag.mkdir()
    files = {'robot_run_0.mcap': b'first segment', 'robot_run_1.mcap': b'second segment',
             'metadata.yaml': b'bag metadata', 'trial.yaml': b'evidence'}
    for name, content in files.items():
        (bag / name).write_bytes(content)
    other = output / 'notes'
    other.mkdir()
    (other / 'keep.txt').write_text('keep')
    listing = recorder.list_bags()
    assert len(listing['bags']) == 1
    entry = listing['bags'][0]
    assert entry['name'] == bag.name and entry['has_mcap']
    size = sum(map(len, files.values()))
    assert entry['size_bytes'] == listing['total_used_bytes'] == size
    assert recorder.delete_bag(recorder.BagRef(bag_name=bag.name)) == {'deleted': bag.name}
    assert not bag.exists()
    assert (other / 'keep.txt').read_text() == 'keep'
    assert recorder.list_bags()['total_used_bytes'] == 0
