// Reading a ROS 2 bag recorded on the robot (robot_manager's recording card, `ros2 bag record -s
// mcap`) in the browser, and turning the topics the lessons use into the same messages
// questix_lab_bridge sends over the live link. No DOM: `readRosbag` takes the file's bytes, so the
// whole path is checked in Node against a bag written by rosbag2 (test/rosbag-core.test.mjs).
//
// Three layers, each small enough to read in one go:
//   1. MCAP records (https://mcap.dev/spec): schemas, channels and messages, including the ones
//      inside uncompressed chunks. rosbag2's default MCAP profile does not compress; a bag recorded
//      with a compression preset is refused with a message instead of being read wrongly.
//   2. ros2msg definitions (the schema text rosbag2 embeds) parsed into field lists.
//   3. CDR (XCDR1) decoding of one message against such a field list.
//
// Only the channels of the four message types below, and /tf_static for where the LiDAR sits, are
// decoded; everything else in a bag recorded with `-a` (camera images, point clouds, logs) is
// skipped without being parsed.

const MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]; // "\x89MCAP0\r\n"
const OP = {
  schema: 0x03,
  channel: 0x04,
  message: 0x05,
  chunk: 0x06,
  dataEnd: 0x0f,
  footer: 0x02,
};

// Must stay equal to the defaults in questix_lab_bridge/config/lab_bridge.yaml (and so to
// launcher/config/drive_component.yaml): a bag carries no wheel geometry of its own.
const BAG_DEFAULT_CONFIG = { wheel_radius: 0.1, wheel_separation: 0.5 };
const BAG_SCAN_MAX_POINTS = 360; // questix_lab_bridge `scan_max_points`
const COMMAND_TOPIC = '/target_twist'; // the command drive_component follows
const STATIC_TF_TOPIC = '/tf_static';
const BASE_FRAME = 'base_link'; // questix_lab_bridge `base_frame`

const STREAM_TYPES = {
  'sensor_msgs/LaserScan': 'scan',
  'nav_msgs/Odometry': 'odom',
  'questix_msgs/DriveStatus': 'drive',
  'geometry_msgs/Twist': 'twist',
};

const bagError = (text) => new Error(text);

// --- 1. MCAP records ------------------------------------------------------------------------

// Little-endian cursor over a DataView. MCAP lengths and times are u64; lengths are converted to
// Number (a browser cannot hold a buffer anywhere near 2^53 bytes), times stay BigInt until they
// are turned into seconds.
function cursor(view, offset = 0) {
  const text = new TextDecoder();
  const at = { offset };
  const take = (size) => {
    if (at.offset + size > view.byteLength)
      throw bagError('rosbagのファイルが途中で切れています。');
    const start = at.offset;
    at.offset += size;
    return start;
  };
  return {
    at,
    u8: () => view.getUint8(take(1)),
    u16: () => view.getUint16(take(2), true),
    u32: () => view.getUint32(take(4), true),
    u64: () => view.getBigUint64(take(8), true),
    bytes(size) {
      const start = take(size);
      return new Uint8Array(view.buffer, view.byteOffset + start, size);
    },
    string() {
      return text.decode(this.bytes(this.u32()));
    },
  };
}

// Nanoseconds since the epoch as seconds, keeping microseconds (a Number cannot hold epoch ns).
const nsToSeconds = (ns) => Number(ns / 1000n) / 1e6;

function readSchema(body) {
  return { id: body.u16(), name: body.string(), encoding: body.string(), data: body.string() };
}

function readChannel(body) {
  const channel = { id: body.u16(), schemaId: body.u16(), topic: body.string() };
  channel.encoding = body.string();
  return channel; // the metadata map that follows is not needed
}

function readMessage(body, end) {
  const channelId = body.u16();
  body.u32(); // sequence
  const logTime = body.u64();
  body.u64(); // publish time
  return { channelId, logTime, data: body.bytes(end - body.at.offset) };
}

// Walk the records in `view[from, to)`, handing schemas, channels and messages to `sink`.
function walkRecords(view, from, to, sink) {
  const reader = cursor(view, from);
  while (reader.at.offset < to) {
    const opcode = reader.u8();
    const length = Number(reader.u64());
    const start = reader.at.offset;
    const end = start + length;
    if (end > to) throw bagError('rosbagのファイルが途中で切れています。');
    const body = cursor(view, start);
    if (opcode === OP.schema) sink.schema(readSchema(body));
    else if (opcode === OP.channel) sink.channel(readChannel(body));
    else if (opcode === OP.message) sink.message(readMessage(body, end));
    else if (opcode === OP.chunk) readChunk(view, body, sink);
    else if (opcode === OP.dataEnd || opcode === OP.footer) return;
    reader.at.offset = end;
  }
}

function readChunk(view, body, sink) {
  body.u64(); // message start time
  body.u64(); // message end time
  body.u64(); // uncompressed size
  body.u32(); // uncompressed crc
  const compression = body.string();
  const size = Number(body.u64());
  if (compression)
    throw bagError(
      `圧縮されたrosbag（${compression}）は読み込めません。圧縮なし（ros2 bag recordの既定）で記録したものを使ってください。`,
    );
  const start = body.at.offset;
  walkRecords(view, start, start + size, sink);
}

/** Every message of the bag with its channel, schema name and log time, in file order. */
function readMcap(buffer) {
  const view = buffer instanceof DataView ? buffer : new DataView(buffer);
  if (view.byteLength < MAGIC.length || MAGIC.some((byte, i) => view.getUint8(i) !== byte))
    throw bagError(
      'MCAP形式のrosbagではありません。ros2 bag record -s mcap で記録した .mcap を選んでください。',
    );
  const schemas = new Map();
  const channels = new Map();
  const messages = [];
  walkRecords(view, MAGIC.length, view.byteLength, {
    schema: (schema) => schemas.set(schema.id, schema),
    channel: (channel) => channels.set(channel.id, channel),
    message: (message) => messages.push(message),
  });
  return { schemas, channels, messages };
}

// --- 2. ros2msg definitions -----------------------------------------------------------------

const PRIMITIVES = {
  bool: 1,
  byte: 1,
  char: 1,
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  int64: 8,
  uint64: 8,
  float32: 4,
  float64: 8,
};

// "pkg/msg/Type", "pkg/Type" and a bare "Type" (same package) all become "pkg/Type".
function qualify(name, pkg) {
  if (name === 'Header') return 'std_msgs/Header';
  const parts = name.split('/');
  if (parts.length === 1) return `${pkg}/${name}`;
  return `${parts[0]}/${parts[parts.length - 1]}`;
}

function parseField(line, pkg) {
  // A constant ("uint8 MODE=1", "string NAME = 'a'") carries no data, and a default value
  // ("int32 x 0") does not matter for decoding. The "<=" of a bounded type is not a constant.
  const match = /^(\S+)\s+([A-Za-z_]\w*)\s*(=)?/.exec(line);
  if (!match || match[3]) return null;
  const [, type, name] = match;
  const array = /^(.+?)\[(<=)?(\d*)\]$/.exec(type);
  const base = (array ? array[1] : type).replace(/<=\d+$/, ''); // "string<=10" is still a string
  const field = {
    name,
    type: base in PRIMITIVES || base === 'string' || base === 'wstring' ? base : qualify(base, pkg),
  };
  if (array) field.length = array[3] && !array[2] ? Number(array[3]) : -1; // -1: sequence
  return field;
}

function parseSection(text, pkg) {
  const fields = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const field = parseField(line, pkg);
    if (field) fields.push(field);
  }
  return fields;
}

/** The field lists of `name` and every type it depends on, from rosbag2's schema text. */
function parseRos2msg(name, text) {
  const types = new Map();
  const sections = text.split(/^=+\s*$/m);
  const top = qualify(name, '');
  types.set(top, parseSection(sections[0], top.split('/')[0]));
  for (const section of sections.slice(1)) {
    const header = /^\s*MSG:\s*(\S+)/.exec(section);
    if (!header) continue;
    const type = qualify(header[1], '');
    types.set(
      type,
      parseSection(section.slice(header.index + header[0].length), type.split('/')[0]),
    );
  }
  return { top, types };
}

// --- 3. CDR -----------------------------------------------------------------------------------

// XCDR1 as used by ROS 2: a 4-byte encapsulation header, then fields aligned to their own size
// (up to 8) counted from the end of that header. Strings and sequences start with a u32 count.
function cdrReader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = view.getUint8(1) === 1; // 0x0001 CDR_LE, 0x0000 CDR_BE
  const text = new TextDecoder();
  let offset = 4;
  const align = (size) => {
    const misalignment = (offset - 4) % size;
    if (misalignment) offset += size - misalignment;
  };
  const read = (size, get) => {
    align(size);
    if (offset + size > view.byteLength)
      throw bagError('rosbagのメッセージを読み取れませんでした。');
    const value = get(offset);
    offset += size;
    return value;
  };
  const readers = {
    bool: () => read(1, (at) => view.getUint8(at) !== 0),
    byte: () => read(1, (at) => view.getUint8(at)),
    char: () => read(1, (at) => view.getUint8(at)),
    int8: () => read(1, (at) => view.getInt8(at)),
    uint8: () => read(1, (at) => view.getUint8(at)),
    int16: () => read(2, (at) => view.getInt16(at, little)),
    uint16: () => read(2, (at) => view.getUint16(at, little)),
    int32: () => read(4, (at) => view.getInt32(at, little)),
    uint32: () => read(4, (at) => view.getUint32(at, little)),
    int64: () => read(8, (at) => Number(view.getBigInt64(at, little))),
    uint64: () => read(8, (at) => Number(view.getBigUint64(at, little))),
    float32: () => read(4, (at) => view.getFloat32(at, little)),
    float64: () => read(8, (at) => view.getFloat64(at, little)),
    string() {
      const size = readers.uint32();
      if (offset + size > view.byteLength)
        throw bagError('rosbagのメッセージを読み取れませんでした。');
      const value = text.decode(bytes.subarray(offset, offset + Math.max(0, size - 1)));
      offset += size;
      return value;
    },
  };
  readers.wstring = readers.string;
  return readers;
}

function decodeType(type, types, readers) {
  if (readers[type]) return readers[type]();
  const fields = types.get(type);
  if (!fields) throw bagError(`rosbagに ${type} の定義がありません。`);
  const message = {};
  for (const field of fields) {
    if (field.length === undefined) {
      message[field.name] = decodeType(field.type, types, readers);
      continue;
    }
    const count = field.length < 0 ? readers.uint32() : field.length;
    const values = new Array(count);
    for (let i = 0; i < count; i += 1) values[i] = decodeType(field.type, types, readers);
    message[field.name] = values;
  }
  return message;
}

/** One CDR-encoded message as a plain object, following the parsed ros2msg definition. */
function decodeCdr(bytes, definition) {
  return decodeType(definition.top, definition.types, cdrReader(bytes));
}

// --- ROS messages as the live link sends them ------------------------------------------------
// Ports of questix_lab_bridge/questix_lab_bridge/messages.py, so a lesson cannot tell a bag from a
// live recording. Keep the two in step.

const stampSeconds = (stamp) => stamp.sec + stamp.nanosec * 1e-9;
const finite = (value, digits) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const yaw = (q) => Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));

function scanPayload(msg, maxPoints = BAG_SCAN_MAX_POINTS) {
  const count = msg.ranges.length;
  const stride = Math.max(1, Math.ceil(count / Math.max(1, maxPoints)));
  const ranges = [];
  for (let index = 0; index < count; index += stride) {
    const value = msg.ranges[index];
    const valid = Number.isFinite(value) && value >= msg.range_min && value <= msg.range_max;
    ranges.push(valid ? Number(value.toFixed(3)) : null);
  }
  return {
    type: 'scan',
    stamp: stampSeconds(msg.header.stamp),
    frame: msg.header.frame_id,
    angle_min: msg.angle_min,
    angle_increment: msg.angle_increment * stride,
    range_min: msg.range_min,
    range_max: msg.range_max,
    ranges,
  };
}

function odomPayload(msg) {
  const pose = msg.pose.pose;
  const twist = msg.twist.twist;
  return {
    type: 'odom',
    stamp: stampSeconds(msg.header.stamp),
    x: finite(pose.position.x, 4),
    y: finite(pose.position.y, 4),
    theta: finite(yaw(pose.orientation), 4),
    v: finite(twist.linear.x, 4),
    w: finite(twist.angular.z, 4),
  };
}

const wheel = (feedback) => ({
  rpm: feedback.velocity_rpm,
  rpm_raw: feedback.velocity_rpm_raw,
  target_rpm: feedback.target_rpm,
  current_amp: finite(feedback.current_amp, 3),
  fault_code: feedback.fault_code,
});

function drivePayload(msg) {
  return {
    type: 'drive',
    stamp: stampSeconds(msg.header.stamp),
    left: wheel(msg.left),
    right: wheel(msg.right),
    v: finite(msg.linear_velocity, 4),
    w: finite(msg.angular_velocity, 4),
    emergency_stop: Boolean(msg.emergency_stop),
  };
}

// Twist has no header: the bridge stamps it on receipt, the bag's log time is the same thing.
const twistPayload = (msg, stamp) => ({
  type: 'twist',
  stamp,
  linear: finite(msg.linear.x, 4),
  angular: finite(msg.angular.z, 4),
});

const PAYLOADS = { scan: scanPayload, odom: odomPayload, drive: drivePayload };

// Where each frame sits on the robot, from the static transforms recorded in the bag: the same
// `mount` questix_lab_bridge looks up in TF (messages.mount_from_transform). Only a frame whose
// parent is the base frame itself is used, which is how QUESTiX publishes its LiDAR.
const stripSlash = (frame) => frame.replace(/^\//, '');

function staticMounts(channels, schemas, messages) {
  const channel = [...channels.values()].find(
    (entry) =>
      entry.topic === STATIC_TF_TOPIC &&
      qualify(schemas.get(entry.schemaId)?.name ?? '', '') === 'tf2_msgs/TFMessage',
  );
  const mounts = new Map();
  if (!channel) return mounts;
  const schema = schemas.get(channel.schemaId);
  const definition = parseRos2msg(schema.name, schema.data);
  for (const message of messages) {
    if (message.channelId !== channel.id) continue;
    for (const stamped of decodeCdr(message.data, definition).transforms) {
      if (stripSlash(stamped.header.frame_id) !== BASE_FRAME) continue;
      const { translation, rotation } = stamped.transform;
      mounts.set(stripSlash(stamped.child_frame_id), {
        x: Number(translation.x.toFixed(4)),
        y: Number(translation.y.toFixed(4)),
        yaw: Number(yaw(rotation).toFixed(4)),
      });
    }
  }
  return mounts;
}

// With several Twist topics in a bag (/cmd_vel, joystick outputs…), only the one drive_component
// follows is the command; a lone Twist topic under another name is taken as it.
function pickChannels(channels, schemas) {
  const picked = new Map();
  const twists = [];
  for (const channel of channels.values()) {
    const schema = schemas.get(channel.schemaId);
    if (!schema || channel.encoding !== 'cdr' || schema.encoding !== 'ros2msg') continue;
    const stream = STREAM_TYPES[qualify(schema.name, '')];
    if (!stream) continue;
    if (stream === 'twist') twists.push(channel);
    else if (!picked.has(stream) || channel.topic === `/${stream}`) picked.set(stream, channel);
  }
  const command =
    twists.find((channel) => channel.topic === COMMAND_TOPIC) ??
    (twists.length === 1 ? twists[0] : null);
  if (command) picked.set('twist', command);
  return picked;
}

/**
 * The lesson streams of a bag: `{streams: {scan, odom, drive, twist}, topics, start, seconds}`.
 * Each stream is a list of live-link messages sorted by stamp; `topics` names the topic each one
 * came from. Throws an Error whose message can be shown to the learner.
 */
function readRosbag(buffer) {
  const { schemas, channels, messages } = readMcap(buffer);
  const picked = pickChannels(channels, schemas);
  if (!picked.size)
    throw bagError(
      'このrosbagには、教材で使うトピック（/drive_status・/target_twist・/scan・/odom）がありません。',
    );
  const byChannel = new Map();
  const definitions = new Map();
  for (const [stream, channel] of picked) {
    byChannel.set(channel.id, stream);
    const schema = schemas.get(channel.schemaId);
    definitions.set(stream, parseRos2msg(schema.name, schema.data));
  }
  const streams = Object.fromEntries([...picked.keys()].map((stream) => [stream, []]));
  let first = null;
  let last = null;
  for (const message of messages) {
    const stream = byChannel.get(message.channelId);
    if (!stream) continue;
    const logTime = nsToSeconds(message.logTime);
    first = first === null ? logTime : Math.min(first, logTime);
    last = last === null ? logTime : Math.max(last, logTime);
    const decoded = decodeCdr(message.data, definitions.get(stream));
    streams[stream].push(
      stream === 'twist' ? twistPayload(decoded, logTime) : PAYLOADS[stream](decoded),
    );
  }
  for (const list of Object.values(streams)) list.sort((a, b) => a.stamp - b.stamp);
  const mounts = staticMounts(channels, schemas, messages);
  for (const scan of streams.scan ?? []) scan.mount = mounts.get(stripSlash(scan.frame)) ?? null;
  const topics = Object.fromEntries(
    [...picked].map(([stream, channel]) => [stream, channel.topic]),
  );
  return { streams, topics, start: first ?? 0, seconds: first === null ? 0 : last - first };
}

export {
  BAG_DEFAULT_CONFIG,
  readMcap,
  parseRos2msg,
  decodeCdr,
  readRosbag,
  scanPayload,
  odomPayload,
  drivePayload,
};
