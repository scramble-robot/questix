"""Controller vote composition must fail closed for every invalid configuration."""

from copy import deepcopy
import importlib.util
from pathlib import Path

import pytest
import yaml
from questix_control_config.permission_profile import compose

ROOT = Path(__file__).parents[2]


@pytest.fixture
def document():
    return yaml.safe_load((ROOT / 'operation_manager/config/operation_manager.permission.yaml')
                          .read_text())


@pytest.mark.parametrize('controller', ['udp', 'uart', 'dualshock', 'web'])
@pytest.mark.parametrize('mode,base', [('lesson', ['teacher']), ('practice', []),
                                     ('competition', ['referee'])])
def test_all_combinations(document, controller, mode, base):
    original = deepcopy(document)
    result = compose(document, controller, mode)['motion_permission_manager']['ros__parameters']
    assert result['required'].get(mode, []) == base + (['controller'] if controller == 'udp' and mode != 'lesson' else [])
    assert 'controller_votes' not in result
    assert original == document


@pytest.mark.parametrize('key,value', [('controller_votes', None), ('controller_votes', []),
    ('controller_votes', {'udp': []}), ('controller_votes', {'udp': ['missing']}),
    ('votes', {}), ('votes', []), ('required', []), ('required', {'unknown': []}),
    ('required', {'lesson': ['missing']}), ('required', {'lesson': 'teacher'}),
    ('required', {'lesson': ['teacher', 'teacher']}), ('modes', ['practice'])])
def test_reject_bad_rules(document, key, value):
    document['motion_permission_manager']['ros__parameters'][key] = value
    with pytest.raises((ValueError, KeyError, TypeError)):
        compose(document, 'udp', 'practice')


@pytest.mark.parametrize('controller,mode', [('bad', 'practice'), ('udp', 'bad')])
def test_unknown(document, controller, mode):
    with pytest.raises(ValueError):
        compose(document, controller, mode)


def load_helper():
    spec = importlib.util.spec_from_file_location('permission_helper',
        ROOT / 'questix_control_config/launch/permission_profile.launch.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_private_file_and_shutdown_cleanup(tmp_path, document):
    from launch import LaunchContext
    helper = load_helper()
    source = tmp_path / 'rules.yaml'
    source.write_text(yaml.safe_dump(document))
    context = LaunchContext()
    context.launch_configurations.update(permission_source_file=str(source),
        controller_type='udp', robot_mode='competition')
    actions = helper.prepare(context)
    actions[1].execute(context)
    path = Path(context.launch_configurations['permission_config_file'])
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert not path.is_symlink()
    assert yaml.safe_load(path.read_text())['motion_permission_manager']['ros__parameters'][
        'required']['competition'] == ['referee', 'controller']
    # Trigger registered shutdown callback via the actual event handler.
    from launch.events import Shutdown
    actions[0].event_handler.handle(Shutdown(reason='test'), context)
    assert not path.exists()


@pytest.mark.parametrize('failure', ['missing', 'yaml', 'shape', 'write'])
def test_prepare_never_falls_back(tmp_path, document, monkeypatch, failure):
    from launch import LaunchContext
    helper = load_helper()
    source = tmp_path / 'rules.yaml'
    if failure != 'missing':
        source.write_text('[' if failure == 'yaml' else yaml.safe_dump(
            {} if failure == 'shape' else document))
    if failure == 'write':
        monkeypatch.setattr(helper.tempfile, 'TemporaryDirectory',
                            lambda **kw: (_ for _ in ()).throw(OSError('write denied')))
    context = LaunchContext()
    context.launch_configurations.update(permission_source_file=str(source),
        controller_type='udp', robot_mode='practice')
    with pytest.raises((OSError, KeyError, yaml.YAMLError)):
        helper.prepare(context)
    assert 'permission_config_file' not in context.launch_configurations


@pytest.mark.parametrize('change', ['unknown_vote', 'missing_vote', 'bad_map', 'missing_map'])
def test_controller_vote_fail_closed(document, change):
    params = document['motion_permission_manager']['ros__parameters']
    if change == 'unknown_vote':
        params['required']['lesson'] = ['not-a-vote']
    elif change == 'missing_vote':
        del params['votes']['controller']
    elif change == 'bad_map':
        params['controller_votes'] = ['controller']
    else:
        del params['controller_votes']
    with pytest.raises((ValueError, KeyError)):
        compose(document, 'udp', 'practice')


def test_file_write_failure_cleans_private_directory(tmp_path, document, monkeypatch):
    from launch import LaunchContext
    helper = load_helper()
    source = tmp_path / 'rules.yaml'
    source.write_text(yaml.safe_dump(document))
    original_open = Path.open
    created = []

    def fail_open(path, *args, **kwargs):
        if path.name == 'permission.yaml':
            created.append(path.parent)
            raise OSError('cannot write permission YAML')
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'open', fail_open)
    context = LaunchContext()
    context.launch_configurations.update(permission_source_file=str(source),
        controller_type='udp', robot_mode='practice')
    with pytest.raises(OSError):
        helper.prepare(context)
    assert created and not created[0].exists()
    assert 'permission_config_file' not in context.launch_configurations


@pytest.mark.parametrize('rules', [
    {'unknown': ['controller']}, {'practice': ['missing']},
    {'practice': ['controller', 'controller']}, {'practice': 'controller'},
    {'practice': [False]}, {'practice': [None]}, {'practice': None},
])
def test_invalid_controller_mode_rules(document, rules):
    document['motion_permission_manager']['ros__parameters']['controller_votes'] = {'udp': rules}
    with pytest.raises(ValueError):
        compose(document, 'udp', 'practice')


def test_unknown_controller_rules_are_rejected(document):
    document['motion_permission_manager']['ros__parameters']['controller_votes']['unknown'] = {}
    with pytest.raises(ValueError):
        compose(document, 'udp', 'practice')


def test_unspecified_modes_receive_no_additional_vote(document):
    params = document['motion_permission_manager']['ros__parameters']
    params['controller_votes']['udp'] = {'competition': ['controller']}
    for mode in ('lesson', 'practice', 'competition'):
        result = compose(document, 'udp', mode)['motion_permission_manager']['ros__parameters']
        assert result['required']['lesson'] == ['teacher']
        assert result['required'].get('practice', []) == []
        assert result['required']['competition'] == ['referee', 'controller']


def test_required_and_controller_vote_duplicates_are_rejected(document):
    params = document['motion_permission_manager']['ros__parameters']
    params['controller_votes']['udp']['lesson'] = ['teacher']
    with pytest.raises(ValueError, match='duplicates a required vote'):
        compose(document, 'udp', 'lesson')
