"""Validate CoRE UDP v3 datagrams and encode status acknowledgements."""
# Ported from the CoRE gamepad UDP bundle (sender uart32-tx-20261114 / receiver uart32-rx-20261114), provided by Scramble and used with the author's permission.

import json
import re
import struct

HEX_ID = re.compile(r"[0-9a-fA-F]{4}\Z")
HEX_DATA = re.compile(r"(?:[0-9a-fA-F]{2})*\Z")
UINT32_MAX = 0xFFFFFFFF
BASE_REQUIRED = {"v", "type", "seq", "ms", "connected", "vid", "pid", "addr",
               "ep", "raw", "reports", "dropped"}
USER_BYTES = 32
V3_REQUIRED = BASE_REQUIRED | {"protocol", "user_valid", "user_age_ms", "user_raw"}


def unique_object(pairs):
    """Reject ambiguous JSON objects, including duplicate version fields."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: " + key)
        result[key] = value
    return result


def parse_packet(data):
    """Validate one datagram and return (JSON object, raw USB bytes).

    Raise ValueError on malformed or unsupported packets; bool is not an integer
    for protocol fields. Only v3 is accepted; it has an
    exact 16-field schema with 32 opaque user bytes. Duplicate keys are never accepted.
    """
    if len(data) > 768:
        raise ValueError("v3 datagram exceeds 768 bytes")
    try:
        packet = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("invalid UTF-8 JSON") from exc
    if not isinstance(packet, dict):
        raise ValueError("packet must be a JSON object")
    version = packet.get("v")
    if type(version) is not int or version != 3:
        raise ValueError("unsupported protocol version")
    required = V3_REQUIRED
    if not required.issubset(packet):
        raise ValueError("missing fields: " + ", ".join(sorted(required - packet.keys())))
    for name in ("v", "seq", "ms", "addr", "ep", "reports", "dropped"):
        value = packet[name]
        if type(value) is not int or not 0 <= value <= UINT32_MAX:
            raise ValueError(name + " must be an unsigned 32-bit integer")
    if b"\\" in data:
        raise ValueError("v3 string escapes are not permitted")
    if packet.keys() != required:
        raise ValueError("unknown fields: " + ", ".join(sorted(packet.keys() - required)))
    if packet["type"] not in ("input", "status"):
        raise ValueError("unknown packet type")
    if type(packet["connected"]) is not bool:
        raise ValueError("connected must be a boolean")
    protocol = packet["protocol"]
    if protocol not in ("none", "hid", "xinput"):
        raise ValueError("protocol must be none, hid or xinput")
    if packet["connected"] != (protocol != "none"):
        raise ValueError("protocol and connected disagree")
    if type(packet["user_valid"]) is not bool:
        raise ValueError("user_valid must be a boolean")
    age = packet["user_age_ms"]
    if type(age) is not int or not 0 <= age <= UINT32_MAX:
        raise ValueError("user_age_ms must be an unsigned 32-bit integer")
    user_raw = packet["user_raw"]
    if not isinstance(user_raw, str) or not HEX_DATA.fullmatch(user_raw):
        raise ValueError("user_raw must contain contiguous pairs of hex digits")
    if len(user_raw) != USER_BYTES * 2:
        raise ValueError("user_raw must contain exactly 32 bytes (64 hex digits)")
    if not packet["user_valid"] and (age != UINT32_MAX or any(bytes.fromhex(user_raw))):
        raise ValueError("invalid user data requires 32 zero bytes and unknown age")
    for name in ("vid", "pid"):
        if not isinstance(packet[name], str) or not HEX_ID.fullmatch(packet[name]):
            raise ValueError(name + " must contain exactly four hex digits")
    raw = packet["raw"]
    if not isinstance(raw, str) or not HEX_DATA.fullmatch(raw):
        raise ValueError("raw must contain contiguous pairs of hex digits")
    payload = bytes.fromhex(raw)
    if packet["connected"]:
        if not 1 <= packet["addr"] <= 127:
            raise ValueError("connected device address must be 1..127")
    elif packet["addr"] != 0 or int(packet["vid"], 16) != 0 or int(packet["pid"], 16) != 0:
        raise ValueError("disconnected status must have zero address, VID and PID")
    if packet["type"] == "input":
        if not packet["connected"]:
            raise ValueError("input requires connected=true")
        if not 1 <= packet["ep"] <= 15:
            raise ValueError("input endpoint must be 1..15")
        if not 1 <= len(payload) <= 64:
            raise ValueError("input payload must be 1..64 bytes")
    elif packet["ep"] != 0 or payload:
        raise ValueError("status must have endpoint 0 and empty raw data")
    return packet, payload


def status_ack(packet):
    """Encode PeerAck.h's 16-byte reply, only for a validated status packet."""
    if packet["type"] != "status":
        return None
    # ACK sequence and sender milliseconds are big-endian uint32 values.
    return b"GPACK001" + struct.pack(">II", packet["seq"], packet["ms"])
