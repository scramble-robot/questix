import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSlam } from '../js/slam/usb-slam-core.js';
import { TminiParser } from '../js/slam/usb-protocol.js';
import { UsbLidar, deviceModel } from '../js/slam/usb-serial.js';
function scan(pose) {
  let a = [];
  for (let i = 0; i < 360; i++) {
    const th = (i * Math.PI) / 180;
    const dx = Math.cos(th + pose.theta),
      dy = Math.sin(th + pose.theta);
    let ts = [];
    for (let x of [-3, 4]) {
      let t = (x - pose.x) / dx,
        y = pose.y + t * dy;
      if (t > 0.1 && y >= -2 && y <= 3) ts.push(t);
    }
    for (let y of [-2, 3]) {
      let t = (y - pose.y) / dy,
        x = pose.x + t * dx;
      if (t > 0.1 && x >= -3 && x <= 4) ts.push(t);
    }
    let r = Math.min(...ts);
    if (Number.isFinite(r)) a.push({ x: r * Math.cos(th), y: r * Math.sin(th), r });
  }
  return a;
}
test('local SLAM tracks motion and rejects a jump without altering the map', () => {
  let slam = new BrowserSlam(),
    target;
  for (let i = 0; i < 60; i++) {
    target = { x: i * 0.008, y: i * 0.003, theta: i * 0.003 };
    const r = slam.process(scan(target));
    assert(r.ok, 'synthetic scan rejected ' + i);
  }
  assert(Math.hypot(slam.pose.x - target.x, slam.pose.y - target.y) < 0.05);
  assert(Math.abs(slam.pose.theta - target.theta) < 0.03);
  assert(slam.grid.some((v) => v >= 3));
  assert(slam.grid.some((v) => v < 0));
  let before = slam.accepted;
  let r = slam.process(scan({ x: 3, y: 2, theta: 1 }));
  assert(!r.ok);
  assert.equal(slam.accepted, before);
});

function packet(start, first, last) {
  const count = 60;
  const bytes = new Uint8Array(10 + count * 3);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x55aa, true);
  bytes[2] = Number(start);
  bytes[3] = count;
  view.setUint16(4, Math.round(first * 64) * 2 + 1, true);
  view.setUint16(6, Math.round(last * 64) * 2 + 1, true);
  let checksum =
    view.getUint16(0, true) ^
    view.getUint16(2, true) ^
    view.getUint16(4, true) ^
    view.getUint16(6, true);
  for (let i = 0; i < count; i++) {
    bytes[10 + 3 * i] = 7;
    view.setUint16(11 + 3 * i, 8000, true);
    checksum ^= 7 ^ 8000;
  }
  view.setUint16(8, checksum, true);
  return bytes;
}
function rotations() {
  return Uint8Array.from(
    Array.from({ length: 4 }, () => [
      packet(true, 0, 119),
      packet(false, 120, 239),
      packet(false, 240, 359),
    ])
      .flat()
      .flatMap((bytes) => [...bytes]),
  );
}
test('packet fragmentation preserves complete scans and metric distances', () => {
  const bytes = rotations();
  let reference;
  for (const stride of [1, 2, 7, 37, 256, bytes.length]) {
    const scans = [];
    const parser = new TminiParser((scan) => scans.push(scan));
    for (let offset = 0; offset < bytes.length; offset += stride)
      parser.feed(bytes.slice(offset, offset + stride));
    assert.equal(scans.length, 3);
    assert.equal(parser.errors, 0);
    assert(scans.flat().every((point) => point.r === 2));
    if (reference) assert.deepEqual(scans, reference);
    else reference = scans;
  }
});
test('checksum corruption discards the damaged revolution and resynchronizes', () => {
  const bytes = rotations();
  bytes[250] ^= 32;
  const scans = [];
  const parser = new TminiParser((scan) => scans.push(scan));
  parser.feed(bytes);
  assert.equal(parser.errors, 1);
  assert.equal(parser.dropped, 1);
  assert.equal(scans.length, 2);
});
test('device descriptor validates every header byte', () => {
  const bytes = Uint8Array.from([0xa5, 0x5a, 20, 0, 0, 0, 4, 151, ...new Array(19).fill(0)]);
  assert.equal(deviceModel(bytes), 151);
  bytes[3] = 1;
  assert.equal(deviceModel(bytes), null);
});
function mockPort(model = 151) {
  let controller;
  const writes = [];
  let closed = 0;
  const port = {
    readable: new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
    writable: new WritableStream({
      write(bytes) {
        writes.push(bytes[1]);
        if (bytes[1] === 0x90)
          controller.enqueue(
            Uint8Array.from([0xa5, 0x5a, 20, 0, 0, 0, 4, model, ...new Array(19).fill(0)]),
          );
      },
    }),
    async open() {},
    async setSignals() {},
    async close() {
      closed++;
    },
  };
  return { port, writes, closed: () => closed };
}
test('handshake starts only a supported model and releases both stream locks', async () => {
  for (const model of [151, 1]) {
    const mock = mockPort(model);
    const lidar = new UsbLidar(
      { requestPort: async () => mock.port },
      () => {},
      () => {},
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    );
    if (model === 151) {
      await lidar.connect();
      assert(mock.writes.includes(0x60));
    } else {
      await assert.rejects(lidar.connect(), /wrongModel/);
      assert(!mock.writes.includes(0x60));
    }
    await lidar.close();
    assert.equal(mock.closed(), 1);
    assert(!mock.port.readable.locked);
    assert(!mock.port.writable.locked);
  }
});
test('leaving while the chooser is open never opens the selected port', async () => {
  let choose;
  let opened = false;
  const lidar = new UsbLidar(
    { requestPort: () => new Promise((resolve) => (choose = resolve)) },
    () => {},
    () => {},
  );
  const connecting = lidar.connect();
  await lidar.close();
  choose({
    open() {
      opened = true;
    },
  });
  await assert.rejects(connecting, { name: 'AbortError' });
  assert(!opened);
});
test('leaving during open closes the eventual port without starting scans', async () => {
  const mock = mockPort();
  let finish;
  mock.port.open = () => new Promise((resolve) => (finish = resolve));
  const lidar = new UsbLidar(
    { requestPort: async () => mock.port },
    () => {},
    () => {},
  );
  const connecting = lidar.connect();
  await Promise.resolve();
  await lidar.close();
  finish();
  await assert.rejects(connecting, { name: 'AbortError' });
  assert.equal(mock.closed(), 1);
  assert(!mock.writes.includes(0x60));
});
