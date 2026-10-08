#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""ROS 2 なしで rosbag2 の MCAP（圧縮なし）を読む最小限のリーダ.

scripts/robot_manager/static/lab/js/live/rosbag-core.js と同じ 3 層を Python に移したもの:
  1. MCAP のレコード（schema / channel / message、圧縮なしの chunk の中も）
  2. rosbag2 が埋め込む ros2msg 定義をフィールドの並びに分解
  3. CDR（XCDR1）を 1 メッセージずつ、その定義に沿って dict に復号

rosbag2 の MCAP の既定（ros2 bag record、record.sh）は圧縮なし。圧縮された chunk は誤って
読まずに例外にする。ROS 2 環境（rosbag2_py）があればそちらを使えばよく、これは ROS の無い
PC やクラウドで記録を解析するためのもの。標準ライブラリだけで動く。
"""
from __future__ import annotations

import glob
import os
import struct

MAGIC = b"\x89MCAP0\r\n"
OP_FOOTER = 0x02
OP_SCHEMA = 0x03
OP_CHANNEL = 0x04
OP_MESSAGE = 0x05
OP_CHUNK = 0x06
OP_DATA_END = 0x0F


class BagError(Exception):
    """読めない bag（MCAP でない・圧縮されている・途中で切れている）。"""


class _Cursor:
    def __init__(self, data, offset=0):
        self.data = data
        self.offset = offset

    def take(self, size):
        if self.offset + size > len(self.data):
            raise BagError("bag のファイルが途中で切れています")
        start = self.offset
        self.offset += size
        return start

    def u8(self):
        return self.data[self.take(1)]

    def u16(self):
        return struct.unpack_from("<H", self.data, self.take(2))[0]

    def u32(self):
        return struct.unpack_from("<I", self.data, self.take(4))[0]

    def u64(self):
        return struct.unpack_from("<Q", self.data, self.take(8))[0]

    def bytes(self, size):
        start = self.take(size)
        return self.data[start:start + size]

    def string(self):
        return bytes(self.bytes(self.u32())).decode("utf-8")


def _walk(data, start, end, schemas, channels, messages):
    cur = _Cursor(data, start)
    while cur.offset < end:
        opcode = cur.u8()
        length = cur.u64()
        body_start = cur.offset
        body_end = body_start + length
        if body_end > end:
            raise BagError("bag のファイルが途中で切れています")
        body = _Cursor(data, body_start)
        if opcode == OP_SCHEMA:
            sid = body.u16()
            schemas[sid] = {"name": body.string(), "encoding": body.string(),
                            "data": body.string()}
        elif opcode == OP_CHANNEL:
            cid = body.u16()
            channels[cid] = {"schema_id": body.u16(), "topic": body.string(),
                             "encoding": body.string()}
        elif opcode == OP_MESSAGE:
            cid = body.u16()
            body.u32()  # sequence
            log_time = body.u64()
            body.u64()  # publish time
            messages.append((cid, log_time, data[body.offset:body_end]))
        elif opcode == OP_CHUNK:
            body.u64()  # message start time
            body.u64()  # message end time
            body.u64()  # uncompressed size
            body.u32()  # uncompressed crc
            compression = body.string()
            size = body.u64()
            if compression:
                raise BagError(f"圧縮された bag（{compression}）は読めません（record.sh の既定は"
                               "圧縮なし）。ROS 2 環境の rosbag2_py で読んでください")
            _walk(data, body.offset, body.offset + size, schemas, channels, messages)
        elif opcode in (OP_DATA_END, OP_FOOTER):
            return
        cur.offset = body_end


def read_mcap(path):
    """(schemas, channels, messages) を返す。messages は (channel_id, log_time_ns, bytes)。"""
    with open(path, "rb") as f:
        data = memoryview(f.read())
    if bytes(data[:len(MAGIC)]) != MAGIC:
        raise BagError(f"{path} は MCAP ではありません")
    schemas, channels, messages = {}, {}, []
    _walk(data, len(MAGIC), len(data), schemas, channels, messages)
    return schemas, channels, messages


# --- ros2msg ---------------------------------------------------------------------------------

_PRIMITIVES = {
    "bool": ("?", 1), "byte": ("B", 1), "char": ("B", 1), "int8": ("b", 1), "uint8": ("B", 1),
    "int16": ("h", 2), "uint16": ("H", 2), "int32": ("i", 4), "uint32": ("I", 4),
    "int64": ("q", 8), "uint64": ("Q", 8), "float32": ("f", 4), "float64": ("d", 8),
}


def _qualify(name, pkg):
    if name == "Header":
        return "std_msgs/Header"
    parts = name.split("/")
    if len(parts) == 1:
        return f"{pkg}/{name}"
    return f"{parts[0]}/{parts[-1]}"


def _parse_field(line, pkg):
    import re

    match = re.match(r"^(\S+)\s+([A-Za-z_]\w*)\s*(=)?", line)
    if not match or match.group(3):
        return None  # 定数は中身を持たない
    type_, name = match.group(1), match.group(2)
    array = re.match(r"^(.+?)\[(<=)?(\d*)\]$", type_)
    base = re.sub(r"<=\d+$", "", array.group(1) if array else type_)
    if base not in _PRIMITIVES and base not in ("string", "wstring"):
        base = _qualify(base, pkg)
    length = None
    if array:
        length = int(array.group(3)) if array.group(3) and not array.group(2) else -1
    return (name, base, length)


def _parse_section(text, pkg):
    fields = []
    for raw in text.split("\n"):
        line = raw.split("#", 1)[0].strip()
        if line:
            field = _parse_field(line, pkg)
            if field:
                fields.append(field)
    return fields


def parse_ros2msg(name, text):
    """(トップの型名, {型名: [(フィールド名, 型, 長さ or None)]})。長さ -1 は可変長配列。"""
    import re

    types = {}
    sections = re.split(r"^=+\s*$", text, flags=re.M)
    top = _qualify(name, "")
    types[top] = _parse_section(sections[0], top.split("/")[0])
    for section in sections[1:]:
        header = re.match(r"^\s*MSG:\s*(\S+)", section)
        if not header:
            continue
        type_ = _qualify(header.group(1), "")
        types[type_] = _parse_section(section[header.end():], type_.split("/")[0])
    return top, types


# --- CDR -------------------------------------------------------------------------------------

class _Cdr:
    def __init__(self, data):
        self.data = data
        self.little = data[1] == 1
        self.offset = 4

    def read(self, kind):
        if kind in ("string", "wstring"):
            size = self.read("uint32")
            if self.offset + size > len(self.data):
                raise BagError("メッセージを読み取れませんでした")
            value = bytes(self.data[self.offset:self.offset + max(0, size - 1)])
            self.offset += size
            return value.decode("utf-8", "replace")
        fmt, size = _PRIMITIVES[kind]
        misalign = (self.offset - 4) % size
        if misalign:
            self.offset += size - misalign
        if self.offset + size > len(self.data):
            raise BagError("メッセージを読み取れませんでした")
        value = struct.unpack_from(("<" if self.little else ">") + fmt, self.data, self.offset)[0]
        self.offset += size
        return value


def _decode(type_, types, cdr):
    if type_ in _PRIMITIVES or type_ in ("string", "wstring"):
        return cdr.read(type_)
    fields = types.get(type_)
    if fields is None:
        raise BagError(f"bag に {type_} の定義がありません")
    out = {}
    for name, base, length in fields:
        if length is None:
            out[name] = _decode(base, types, cdr)
        else:
            count = cdr.read("uint32") if length < 0 else length
            out[name] = [_decode(base, types, cdr) for _ in range(count)]
    return out


def decode_cdr(data, definition):
    """CDR のバイト列を dict に復号する（definition は parse_ros2msg の戻り値）。"""
    top, types = definition
    return _decode(top, types, _Cdr(data))


def find_mcap(bag_path):
    """bag ディレクトリ（または .mcap ファイル）から .mcap のパスを返す。"""
    if os.path.isfile(bag_path):
        return bag_path
    files = sorted(glob.glob(os.path.join(bag_path, "*.mcap")))
    if not files:
        raise BagError(f"{bag_path} に .mcap がありません")
    return files[0]


def read_topics(bag_path, topics):
    """指定 topic のメッセージを {topic: [(log_time_ns, dict)]} で返す（記録順）。"""
    schemas, channels, messages = read_mcap(find_mcap(bag_path))
    wanted = {}
    for cid, ch in channels.items():
        if ch["topic"] not in topics:
            continue
        schema = schemas.get(ch["schema_id"])
        if ch["encoding"] != "cdr" or not schema or schema["encoding"] != "ros2msg":
            raise BagError(f"{ch['topic']} は CDR / ros2msg ではありません")
        wanted[cid] = (ch["topic"], parse_ros2msg(schema["name"], schema["data"]))
    out = {topic: [] for topic in topics}
    for cid, log_time, data in messages:
        if cid in wanted:
            topic, definition = wanted[cid]
            out[topic].append((log_time, decode_cdr(data, definition)))
    return out
