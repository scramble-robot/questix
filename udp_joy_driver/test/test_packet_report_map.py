"""Validate schema, wire decoders, byte quantization and native Joy positions."""

import json
from pathlib import Path

import pytest

from udp_joy_driver.joy_map import BUTTON_BITS, map_joy, normalize_axis
from udp_joy_driver.packet import parse_packet, status_ack
from udp_joy_driver.report import Report, axis_byte, decode


def test_packet_and_ack(packet):
    p = packet()
    assert parse_packet(json.dumps(p).encode()) == (p, bytes.fromhex(p['raw']))
    assert status_ack(p) is None
    p = packet(kind='status', seq=0x01020304, ms=0x05060708)
    assert parse_packet(json.dumps(p).encode()) == (p, b'')
    assert status_ack(p) == b'GPACK001\x01\x02\x03\x04\x05\x06\x07\x08'


@pytest.mark.parametrize('change', [dict(v=1), dict(v=True), dict(seq=True), dict(seq=-1),
    dict(ms=2**32), dict(raw='gh'), dict(raw='0'), dict(raw=''), dict(raw='00' * 65),
    dict(connected=1), dict(protocol='bad'), dict(ep=0), dict(addr=128), dict(vid='123'),
    dict(pid=1234), dict(type='bad'), dict(user_raw='00'), dict(user_valid=0),
    dict(user_age_ms=True), dict(user_raw='11' * 32), dict(extra=0), dict(reports=1.5)])
def test_reject_field(packet, change):
    with pytest.raises(ValueError):
        parse_packet(json.dumps(packet(**change)).encode())


@pytest.mark.parametrize('data', [b'{', b'[]', b'\xff', b' ' * 769,
    b'{"v":3,"v":3}', b'{}'])
def test_invalid_json(data):
    with pytest.raises(ValueError):
        parse_packet(data)


def test_every_required_key(packet):
    p = packet()
    for key in p:
        with pytest.raises(ValueError):
            parse_packet(json.dumps({k: v for k, v in p.items() if k != key}).encode())


@pytest.mark.parametrize('prefix', [b'', b'\xff', b'\xff\xfe'])
@pytest.mark.parametrize('length', [14, 20, 28])
def test_xinput_clone(packet, prefix, length):
    raw = bytes.fromhex(packet(buttons=0x1420, x=-32768)['raw'])
    result = decode(prefix + (raw + bytes(8))[:length], 'xinput')
    assert result.axes == (0, 128, 128, 128)
    assert result.buttons == (1 << 8) | (1 << 12) | (1 << 1)


@pytest.mark.parametrize('raw,protocol', [(b'', 'hid'), (b'\x00' * 20, 'hid'),
    (b'\x01' + b'\x00' * 4 + b'\x09' + b'\x00' * 4, 'hid'),
    (b'\x00' * 13, 'xinput'), (b'\x00' * 33, 'xinput'), (b'\xff' * 20, 'xinput'),
    (b'\x00' * 20, 'none')])
def test_unknown_report(raw, protocol):
    assert decode(raw, protocol) is None


def test_ps4_and_endpoints():
    result = decode(bytes([1, 0, 128, 255, 128, 0xf8, 0xff, 3, 0, 0]), 'hid')
    assert result == Report((0, 128, 255, 128), 0x3fff, 8)
    assert [axis_byte(v) for v in (-32768, 0, 32767)] == [0, 128, 255]
    assert [axis_byte(v, True) for v in (-32768, 0, 32767)] == [255, 128, 0]


@pytest.mark.parametrize('index,bit', list(enumerate(BUTTON_BITS)))
def test_button_mapping(index, bit):
    _, buttons = map_joy(Report((128,) * 4, 1 << bit), 0.1)
    assert buttons == [int(i == index) for i in range(14)]


@pytest.mark.parametrize('i,axis', enumerate((0, 1, 3, 4)))
@pytest.mark.parametrize('value,expected', [(0, 1), (128, 0), (255, -1)])
def test_uart_axis_equivalence(i, axis, value, expected):
    values = [128] * 4
    values[i] = value
    axes, _ = map_joy(Report(tuple(values), 0), 0.1)
    assert axes == [expected if n == axis else 0 for n in range(8)]
    # Guard the source formula/sign against a future UART contract change.
    source = (Path(__file__).parents[2] / 'uart_joy_driver/src/joy_line_parser.cpp').read_text()
    assert '(static_cast<int>(value) - 128) / 127.0' in source
    assert f'joy_msg.axes[{axis}] = static_cast<float>(normalizeAxis(' in source


@pytest.mark.parametrize('hat,xy', enumerate(((0, 1), (-1, 1), (-1, 0), (-1, -1),
    (0, -1), (1, -1), (1, 0), (1, 1), (0, 0))))
def test_dpad(hat, xy):
    assert tuple(map_joy(Report((128,) * 4, 0, hat), 0.1)[0][6:]) == xy


def test_deadzone_boundary_and_no_trigger_axes():
    boundary = 12 / 127
    assert normalize_axis(140, boundary) == -boundary
    assert normalize_axis(140, boundary + 1e-6) == 0
    assert map_joy(Report((128,) * 4, (1 << 6) | (1 << 7)), 0.1)[0] == [0] * 8


@pytest.mark.parametrize('mask,bit', [(0x4000, 0), (0x1000, 1), (0x2000, 2), (0x8000, 3),
    (0x0100, 4), (0x0200, 5), (0x0020, 8), (0x0010, 9), (0x0040, 10),
    (0x0080, 11), (0x0400, 12)])
def test_xinput_wire_buttons(packet, mask, bit):
    report = decode(bytes.fromhex(packet(buttons=mask)['raw']), 'xinput')
    assert report.buttons == 1 << bit


@pytest.mark.parametrize('mask,xy', [(1, (0, 1)), (9, (-1, 1)), (8, (-1, 0)),
    (10, (-1, -1)), (2, (0, -1)), (6, (1, -1)), (4, (1, 0)), (5, (1, 1)),
    (15, (0, 0))])
def test_direct_dpad(packet, mask, xy):
    report = decode(bytes.fromhex(packet(buttons=mask)['raw']), 'xinput')
    axes, _ = map_joy(report, 0.1)
    assert tuple(axes[6:]) == xy
