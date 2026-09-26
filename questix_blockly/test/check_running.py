"""Check real HTTP -> ROS -> odometry motion and stop behavior on domain 75."""
import os
import json
import math
import time
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError

BASE = os.environ.get('QUESTIX_BLOCKLY_URL', 'http://127.0.0.1:5174').rstrip('/') + '/api/'


def call(path, data=None):
    request = Request(BASE+path, data=json.dumps(data).encode() if data else None,
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=2) as response:
        return json.load(response)


def run(plan):
    ident = str(uuid.uuid4())
    call('run', dict(id=ident, plan=plan))
    return ident


def step(v=0., w=0., seconds=1.):
    return dict(v=v, w=w, seconds=seconds)


def wait(ident, seconds, heartbeat=True):
    end = time.monotonic()+seconds
    while time.monotonic() < end:
        if heartbeat:
            call('heartbeat', dict(id=ident))
        time.sleep(0.15)
    return call('status')


ident = None
try:
    before = call('status')
    assert before['connected'] and not before['running']
    ident = run([step(v=0.3, seconds=1.2)])
    after = wait(ident, 2)
    assert not after['running'] and after['reason'] == '実行完了', after
    a, b = before['pose'], after['pose']
    assert math.hypot(b['x']-a['x'], b['y']-a['y']) > 0.25, (a, b)
    assert abs(b['v']) < 0.001
    print('PASS forward via production Joy pipeline and completion stop')
    ident = run([step(w=0.7, seconds=1.2)])
    after = wait(ident, 2)
    assert abs(math.remainder(after['pose']['yaw']-b['yaw'], 2*math.pi)) > 0.5, after
    assert math.hypot(after['pose']['x']-b['x'], after['pose']['y']-b['y']) < 0.02
    print('PASS in-place rotation')
    ident = run([step(v=0.3, seconds=8)])
    moving = wait(ident, 1.)
    assert moving['pose']['v'] > 0.2
    call('stop', dict(id=ident))
    stopped = wait(ident, 0.4, False)
    assert not stopped['running'] and stopped['pose']['v'] == 0.
    print('PASS explicit stop')
    ident = run([step(v=0.3, seconds=8)])
    wait(ident, 0.8)
    disconnected = wait(ident, 1.8, False)
    assert not disconnected['running'] and disconnected['pose']['v'] == 0.
    print('PASS heartbeat loss stops ROS motion')
    ident = str(uuid.uuid4())
    call('stop', dict(id=ident))
    try:
        call('run', dict(id=ident, plan=[step(v=0.3)]))
        raise AssertionError('cancelled run accepted')
    except HTTPError as e:
        assert e.code == 400
    print('PASS delayed cancelled request cannot restart')
    for plan in ([step(v=2)], [step(seconds=-1)], [step(seconds=float('nan'))],
                 [step(seconds=10)]*13, [step()]*201):
        try:
            run(plan)
            raise AssertionError('invalid plan accepted')
        except HTTPError as e:
            assert e.code == 400
    print('PASS invalid values, duration and plan size rejected')
finally:
    if ident:
        call('stop', dict(id=ident))
