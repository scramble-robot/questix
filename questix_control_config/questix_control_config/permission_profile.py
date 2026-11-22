"""Build a private, validated permission profile before starting any child nodes."""

from copy import deepcopy


CONTROLLERS = ('uart', 'dualshock', 'web', 'udp')
MODES = ('lesson', 'practice', 'competition')


def compose(document, controller, mode):
    """Refuse malformed or incomplete vote rules; never fall back to the base YAML."""
    if controller not in CONTROLLERS or mode not in MODES:
        raise ValueError('unknown controller or robot mode')
    result = deepcopy(document)
    params = result['motion_permission_manager']['ros__parameters']
    if set(params['modes']) != set(MODES):
        raise ValueError('permission modes do not match robot modes')
    votes = params['votes']
    if not isinstance(votes, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                            and v.startswith('/') for k, v in votes.items()):
        raise ValueError('votes must map names to absolute topics')
    extra = params.pop('controller_votes')
    if not isinstance(extra, dict) or set(extra) != {'udp'}:
        raise ValueError('controller_votes must contain the udp mode map')
    for rules in extra.values():
        if not isinstance(rules, dict) or set(rules) - set(MODES):
            raise ValueError('controller_votes contains an invalid or unknown mode')
        for names in rules.values():
            if (not isinstance(names, list) or any(not isinstance(n, str) or n not in votes
                                                 for n in names)
                    or len(set(names)) != len(names)):
                raise ValueError('invalid or duplicate controller vote names')
    if votes.get('controller') != '/motion_vote/controller':
        raise ValueError('controller vote topic missing or invalid')
    required = params['required']
    if not isinstance(required, dict) or set(required) - set(MODES):
        raise ValueError('unknown required mode')
    for current in MODES:
        names = required.get(current, [])
        if (not isinstance(names, list) or any(not isinstance(n, str) or n not in votes
                                               for n in names) or len(set(names)) != len(names)):
            raise ValueError('invalid required vote list')
        if 'controller' in names:
            raise ValueError('controller must only be selected by controller_votes')
        additions = extra.get(controller, {}).get(current, [])
        if set(names) & set(additions):
            raise ValueError('controller vote duplicates a required vote')
        names = names + additions
        if names:
            required[current] = names
    params['mode'] = mode
    return result
