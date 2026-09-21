// Exercise the shipped inline controller without ROS, hardware, or npm dependencies.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.listeners = {};
    this.style = {};
    this.children = [];
    this.value = "";
    this.className = "";
    this.textContent = "";
    this.classList = {
      add: () => {}, remove: () => {}, toggle: () => {},
    };
  }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  dispatch(type, data = {}) {
    const event = { target: this, preventDefault() {}, ...data };
    for (const callback of this.listeners[type] || []) callback(event);
  }
  appendChild(child) { this.children.push(child); }
  set innerHTML(_) { this.firstChild = new Element(); this.lastChild = new Element(); }
  querySelector() { return this.knob ??= new Element(); }
  closest() { return ["input", "select", "textarea", "button", "a"].includes(this.tagName) ? this : null; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  blur() {}
}

function controller() {
  const elements = new Map();
  const document = new Element();
  document.hidden = false;
  document.hasFocus = () => true;
  document.documentElement = new Element();
  document.createElement = (tag) => new Element(tag);
  document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const $ = document.getElementById;
  $("inputMode").value = "pointer";
  const window = new Element();
  const sockets = [], timeouts = new Map(), intervals = [], frames = [];
  let timerId = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    end(code = 1006) { this.readyState = 3; this.onclose({ code }); }
    message(value) { this.onmessage({ data: JSON.stringify(value) }); }
    binary(bytes) { this.onmessage({ data: Uint8Array.from(bytes).buffer }); }
  }
  // Camera frames become <img src="blob:..."> via Blob + URL.createObjectURL.
  class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } }
  const blobs = [], revoked = [];
  const URL = {
    createObjectURL: (blob) => { blobs.push(blob); return `blob:${blobs.length}`; },
    revokeObjectURL: (url) => revoked.push(url),
  };
  const source = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8")
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(source, {
    document, window, navigator: {}, WebSocket: Socket, URLSearchParams, Blob, URL, Uint8Array,
    location: { host: "robot.local:8899", protocol: "http:", search: "?token=a%2Bb%26c" },
    setInterval: (callback) => intervals.push(callback),
    setTimeout: (callback) => { timeouts.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timeouts.delete(id),
    requestAnimationFrame: (callback) => frames.push(callback),
  });
  function flush() { while (frames.length) frames.shift()(); }
  function mode(value) { $("inputMode").value = value; $("inputMode").dispatch("change"); flush(); }
  function key(type, code, extra = {}) { document.dispatch(type, { code, ...extra }); flush(); }
  function pointer(id, type, pointerId = 1, x = 0, y = 0, button = 0) {
    const el = typeof id === "string" ? $(id) : id;
    el.dispatch(type, { pointerId, clientX: x, clientY: y, button }); flush();
  }
  function heartbeat() { intervals.forEach((callback) => callback()); }
  function retry() {
    const pending = [...timeouts.values()]; timeouts.clear(); pending.forEach((callback) => callback());
  }
  return { $, document, window, sockets, timeouts, blobs, revoked, mode, key, pointer, flush, heartbeat, retry,
    last: () => sockets.at(-1).sent.at(-1) };
}

function neutral(frame) {
  assert.equal(frame.type, "joy");
  assert.deepEqual(frame.axes, Array(8).fill(0));
  assert.deepEqual(frame.buttons, Array(14).fill(0));
}

test("connection forwards encoded auth token and starts neutral", () => {
  const c = controller();
  assert.equal(c.sockets[0].url, "ws://robot.local:8899/ws?token=a%2Bb%26c");
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  c.sockets[0].open(); neutral(c.last());
});

test("keyboard requires mode and Space first, maps simultaneous movement/actions", () => {
  const c = controller(); c.sockets[0].open();
  c.key("keydown", "Space"); c.key("keydown", "KeyW"); neutral(c.last());
  c.mode("keyboard");
  c.key("keydown", "KeyW"); neutral(c.last());
  c.key("keydown", "Space");
  for (const key of ["KeyW", "KeyA", "KeyQ", "KeyI", "KeyF", "KeyK", "KeyR"]) c.key("keydown", key);
  assert.deepEqual(c.last().axes, [0.707, 0.707, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(c.last().buttons, [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  c.key("keyup", "KeyF"); assert.equal(c.last().buttons[5], 0);
  c.key("keyup", "Space"); neutral(c.last());
  c.key("keydown", "Space"); c.key("keydown", "KeyW", { repeat: true }); neutral(c.last());
});

test("opposite directions cancel, aliases remain active until both are released", () => {
  const c = controller(); c.sockets[0].open(); c.mode("keyboard"); c.key("keydown", "Space");
  for (const key of ["KeyW", "ArrowUp", "KeyS", "KeyQ", "KeyE"]) c.key("keydown", key);
  neutral(c.last());
  c.key("keyup", "KeyS"); c.key("keyup", "KeyW"); assert.equal(c.last().axes[1], 1);
  c.key("keyup", "ArrowUp"); neutral(c.last());
});

test("form controls and browser shortcuts cannot start keyboard actions", () => {
  const c = controller(); c.sockets[0].open(); c.mode("keyboard");
  c.key("keydown", "Space", { target: new Element("select") }); c.key("keydown", "KeyF"); neutral(c.last());
  c.key("keydown", "Space"); c.key("keydown", "KeyW"); assert.equal(c.last().axes[1], 1);
  c.key("keydown", "KeyR", { ctrlKey: true }); neutral(c.last());
});

test("blur, visibility, pagehide, Escape, stop and mode switch clear all input", () => {
  for (const stop of [
    (c) => c.window.dispatch("blur"),
    (c) => { c.document.hidden = true; c.document.dispatch("visibilitychange"); },
    (c) => c.window.dispatch("pagehide"),
    (c) => c.key("keydown", "Escape"),
    (c) => c.$("stop").dispatch("click"),
    (c) => c.mode("pointer"),
  ]) {
    const c = controller(); c.sockets[0].open(); c.mode("keyboard");
    c.key("keydown", "Space"); c.key("keydown", "KeyW"); c.key("keydown", "KeyF");
    stop(c); c.heartbeat(); neutral(c.last());
    c.key("keydown", "KeyW", { repeat: true }); c.heartbeat(); neutral(c.last());
  }
});

test("touch supports simultaneous sticks/buttons and cancellation", () => {
  const c = controller(); c.sockets[0].open(); const fire = c.$("buttons").children[1];
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, -60, 0);
  c.pointer("rightZone", "pointerdown", 2); c.pointer("rightZone", "pointermove", 2, 60, 0);
  c.pointer(fire, "pointerdown", 3);
  assert.equal(c.last().axes[0], 1); assert.equal(c.last().axes[3], -1); assert.equal(c.last().buttons[5], 1);
  c.pointer("leftZone", "pointercancel"); c.pointer("rightZone", "lostpointercapture", 2);
  c.pointer(fire, "pointerup", 3); neutral(c.last());
  c.pointer("leftZone", "pointerdown", 1, 0, 0, 2);
  c.pointer("leftZone", "pointermove", 1, 60, 0); neutral(c.last());
});

test("switching mode cancels an active pointer and rejects further pointer input", () => {
  const c = controller(); c.sockets[0].open();
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  c.mode("keyboard"); c.pointer("leftZone", "pointermove", 1, -60, 0);
  c.pointer("rightZone", "pointerdown", 2); c.pointer("rightZone", "pointermove", 2, 60, 0);
  neutral(c.last());
});

test("disconnect clears held input and ignores input until reconnect is open", () => {
  const c = controller(); c.sockets[0].open(); c.mode("keyboard");
  c.key("keydown", "Space"); c.key("keydown", "KeyF"); c.sockets[0].end();
  c.key("keydown", "Space"); c.key("keydown", "KeyW");
  c.retry(); c.sockets[1].open(); neutral(c.last());
  c.key("keydown", "KeyF", { repeat: true }); c.heartbeat(); neutral(c.last());
});

test("stale socket callbacks cannot break a newer connection", () => {
  const c = controller(); c.sockets[0].open(); c.$("reconnect").dispatch("click");
  c.sockets[1].open(); c.sockets[0].end(); c.sockets[0].message({ type: "released" });
  c.mode("keyboard"); c.key("keydown", "Space"); c.key("keydown", "KeyW");
  assert.equal(c.last().axes[1], 1); assert.equal(c.timeouts.size, 0);
});

test("takeover never automatically reconnects, even without a released message", () => {
  for (const message of [true, false]) {
    const c = controller(); c.sockets[0].open();
    if (message) c.sockets[0].message({ type: "released" });
    c.sockets[0].end(4000); c.retry();
    assert.equal(c.$("reconnect").hidden, false);
    c.document.dispatch("visibilitychange"); assert.equal(c.sockets.length, 1);
    c.$("reconnect").dispatch("click"); c.sockets[1].open(); neutral(c.last());
    assert.equal(c.$("reconnect").hidden, true);
  }
});

test("authentication failure exposes the manual reconnect button", () => {
  for (const code of [1008, 4401]) {
    const c = controller(); c.sockets[0].end(code); c.retry();
    assert.equal(c.sockets.length, 1);
    assert.equal(c.$("reconnect").hidden, false);
  }
});

test("hidden pages defer reconnect until visible", () => {
  const c = controller(); c.sockets[0].open(); c.sockets[0].end();
  c.document.hidden = true; c.document.dispatch("visibilitychange"); c.retry();
  assert.equal(c.sockets.length, 1);
  c.document.hidden = false; c.document.dispatch("visibilitychange");
  assert.equal(c.sockets.length, 2); c.sockets[1].open(); neutral(c.last());
});

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9];

test("camera frames show the newest image, never queue, and keep joy input intact", () => {
  const c = controller(); c.sockets[0].open(); const img = c.$("camImg");
  // Frames before the node reports a camera (or from an old node) are ignored.
  c.sockets[0].binary(JPEG); assert.equal(img.src, undefined);
  c.sockets[0].message({ type: "status", camera: "waiting", hold: "active", clients: 1 });
  assert.equal(c.$("camBadge").hidden, false); assert.equal(c.$("camBadgeTitle").textContent, "カメラ待機中");
  c.sockets[0].message({ type: "status", camera: "live", camera_age_ms: 10, hold: "active", clients: 1 });
  c.sockets[0].binary(JPEG);
  assert.equal(img.src, "blob:1"); assert.equal(c.blobs[0].type, "image/jpeg");
  // Still decoding: two more frames arrive, only the last one is shown once decoding ends.
  c.sockets[0].binary(PNG); c.sockets[0].binary(PNG);
  assert.equal(img.src, "blob:1"); assert.equal(c.blobs.length, 1);
  img.onload();
  assert.equal(img.src, "blob:2"); assert.equal(c.blobs[1].type, "image/png"); assert.equal(c.blobs.length, 2);
  img.onload(); assert.deepEqual(c.revoked, ["blob:1"]);
  c.sockets[0].message({ type: "status", camera: "live", camera_age_ms: 10, hold: "active", clients: 1 });
  assert.equal(c.$("camBadge").hidden, true);
  // Binary traffic must not disturb joy frames or the connection state.
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, -60, 0);
  assert.equal(c.last().axes[0], 1);
  c.sockets[0].message({ type: "status", camera: "stale", camera_age_ms: 4200, hold: "active", clients: 1 });
  assert.equal(c.$("camBadgeTitle").textContent, "映像が止まっています");
  assert.equal(c.$("camBadgeSub").textContent, "最後の映像から 4 秒");
  c.sockets[0].message({ type: "status", camera: "disabled", hold: "active", clients: 1 });
  c.sockets[0].binary(JPEG); assert.equal(c.blobs.length, 2);
});
