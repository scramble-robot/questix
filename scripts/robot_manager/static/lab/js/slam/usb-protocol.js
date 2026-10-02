// T-mini Plus model 151: AA55, 8-bit intensity, quarter-millimetre distance.
const HEADER_BYTES = 10;
const SAMPLE_BYTES = 3;
const TIMESTAMP_BYTES = 8;
const MAX_PACKET_POINTS = 80;
const MIN_SCAN_POINTS = 100;
const MAX_SCAN_POINTS = 900;
const MAX_BUFFER_BYTES = 4096;
const MAX_ACCUMULATED_POINTS = 2000;
const MIN_RANGE_METRES = 0.1;
const MAX_RANGE_METRES = 12;
// All words on the wire are little endian; the angle word's low bit is a check bit.
const word = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);

function packetLength(bytes, offset) {
  if (bytes[offset] !== 0xaa) return 1;
  if (bytes[offset + 1] === 0x66) return TIMESTAMP_BYTES;
  if (bytes[offset + 1] !== 0x55) return 1;
  if (offset + HEADER_BYTES > bytes.length) return 0;
  return HEADER_BYTES + SAMPLE_BYTES * bytes[offset + 3];
}
function validPacket(bytes, offset) {
  const count = bytes[offset + 3];
  if (!count || count > MAX_PACKET_POINTS || !(bytes[offset + 4] & 1) || !(bytes[offset + 6] & 1))
    return false;
  let checksum =
    word(bytes, offset) ^
    word(bytes, offset + 2) ^
    word(bytes, offset + 4) ^
    word(bytes, offset + 6);
  for (let i = 0; i < count; i++) {
    const sample = offset + HEADER_BYTES + SAMPLE_BYTES * i;
    checksum ^= bytes[sample] ^ word(bytes, sample + 1);
  }
  return checksum === word(bytes, offset + 8);
}
export class TminiParser {
  constructor(onScan) {
    this.onScan = onScan;
    this.buffer = new Uint8Array();
    this.points = [];
    this.synced = false;
    this.badScan = false;
    this.errors = 0;
    this.packets = 0;
    this.scans = 0;
    this.dropped = 0;
    this.bytes = 0;
  }
  feed(chunk) {
    this.bytes += chunk.length;
    const bytes = new Uint8Array(this.buffer.length + chunk.length);
    bytes.set(this.buffer);
    bytes.set(chunk, this.buffer.length);
    let offset = 0;
    while (offset + 1 < bytes.length) {
      const length = packetLength(bytes, offset);
      if (!length || offset + length > bytes.length) break;
      if (length > TIMESTAMP_BYTES) {
        if (!validPacket(bytes, offset)) {
          this.errors++;
          this.badScan = true;
          offset++;
          continue;
        }
        this.acceptPacket(bytes, offset);
      }
      // AA66 timestamp blocks carry no geometry. SLAM uses each complete revolution.
      offset += length;
    }
    this.buffer = bytes.slice(offset);
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = new Uint8Array();
      this.badScan = true;
    }
  }
  finishScan() {
    if (this.synced) {
      if (
        !this.badScan &&
        this.points.length >= MIN_SCAN_POINTS &&
        this.points.length <= MAX_SCAN_POINTS
      ) {
        this.scans++;
        this.onScan(this.points);
      } else this.dropped++;
    }
    this.points = [];
    this.badScan = false;
    this.synced = true;
  }
  acceptPacket(bytes, offset) {
    this.packets++;
    if (bytes[offset + 2] & 1) this.finishScan();
    const count = bytes[offset + 3];
    const firstDegrees = (word(bytes, offset + 4) >> 1) / 64;
    let lastDegrees = (word(bytes, offset + 6) >> 1) / 64;
    if (lastDegrees < firstDegrees) lastDegrees += 360;
    for (let i = 0; i < count; i++) {
      const raw = word(bytes, offset + HEADER_BYTES + SAMPLE_BYTES * i + 1);
      const r = (raw & 0xfffc) / 4000;
      const degrees = firstDegrees + ((lastDegrees - firstDegrees) * i) / Math.max(1, count - 1);
      // Official reversion=true, inverted=true orientation; no triangulation correction.
      const angle = (-(degrees + 180) * Math.PI) / 180;
      if (r >= MIN_RANGE_METRES && r <= MAX_RANGE_METRES)
        this.points.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), r });
    }
    if (this.points.length > MAX_ACCUMULATED_POINTS) {
      this.points = [];
      this.synced = false;
      this.dropped++;
    }
  }
}
