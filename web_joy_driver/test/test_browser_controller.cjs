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
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
  }
  // Like the DOM: replacing the text drops the children.
  get textContent() { return this._text; }
  set textContent(value) { this._text = value; this.children = []; }
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

const OPERATOR = { id: 1, label: "iPhone", address: "10.42.0.23" };
const OTHER = { id: 2, label: "iPad", address: "10.42.0.31" };

function controller({ matchMedia } = {}) {
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
  if (matchMedia) window.matchMedia = matchMedia;
  const sockets = [], timeouts = new Map(), intervals = [], frames = [];
  let timerId = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.closed = true; }
    // Opening the controller socket delivers the node's welcome: operator by default.
    open(welcome = { controller: true, you: OPERATOR, owner: OPERATOR }) {
      this.readyState = 1; this.onopen();
      if (welcome && this.url.includes("/ws")) {
        this.message({ type: "welcome", robot: { name: "questix-3" }, lab_bridge_port: 8897, ...welcome });
      }
    }
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
    location: { host: "robot.local:8899", hostname: "robot.local", protocol: "http:", search: "?token=a%2Bb%26c" },
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
  const joySockets = () => sockets.filter((s) => s.url.includes("/ws"));
  const labSockets = () => sockets.filter((s) => !s.url.includes("/ws"));
  const joySent = () => joySockets().at(-1).sent;
  return { $, document, window, sockets, timeouts, blobs, revoked, mode, key, pointer, flush, heartbeat, retry,
    joySockets, labSockets, joySent,
    last: () => joySent().filter((m) => m.type === "joy").at(-1) };
}

function neutral(frame) {
  assert.equal(frame.type, "joy");
  assert.deepEqual(frame.axes, Array(8).fill(0));
  assert.deepEqual(frame.buttons, Array(14).fill(0));
}
const status = (extra = {}) => ({ type: "status", hold: "active", clients: 1, controller: true, owner: OPERATOR, ...extra });
const bannerButtons = (c) => c.$("banner").children.find((el) => el.className === "acts")?.children || [];

test("connection forwards encoded auth token, asks for control and starts neutral", () => {
  const c = controller();
  const url = c.sockets[0].url;
  assert.match(url, /^ws:\/\/robot\.local:8899\/ws\?token=a%2Bb%26c&cid=[a-z0-9]{16}&claim=1$/);
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  c.sockets[0].open(); neutral(c.last());
  assert.equal(c.$("robotName").textContent, "questix-3");
  assert.equal(c.$("robot").hidden, false);
  assert.equal(c.document.title, "questix-3 · ブラウザ・スマホで操作");
  assert.equal(c.$("overlay").hidden, true);
  assert.equal(c.$("conn").textContent, "操作中");
  assert.equal(c.$("releaseBtn").hidden, false);
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

test("touch-only devices get no keyboard mode", () => {
  const c = controller({ matchMedia: (q) => ({ matches: q === "(any-pointer: coarse)" }) });
  assert.equal(c.$("app").classList.contains("touch-only"), true);
  c.sockets[0].open(); c.mode("keyboard");
  assert.equal(c.$("inputMode").value, "pointer");
  c.key("keydown", "Space"); c.key("keydown", "KeyW"); neutral(c.last());
  // A tablet with a trackpad, or a device reporting no pointer at all, keeps it.
  for (const matches of [() => true, () => false]) {
    const d = controller({ matchMedia: (q) => ({ matches: matches(q) }) });
    assert.equal(d.$("app").classList.contains("touch-only"), false);
  }
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
  assert.equal(c.$("conn").textContent, "切断");
  c.key("keydown", "Space"); c.key("keydown", "KeyW");
  c.retry(); assert.match(c.sockets[1].url, /claim=1/);  // the operator asks for its role back
  c.sockets[1].open(); neutral(c.last());
  c.key("keydown", "KeyF", { repeat: true }); c.heartbeat(); neutral(c.last());
});

test("stale socket callbacks cannot break a newer connection", () => {
  const c = controller(); c.sockets[0].open(); c.$("overlayReconnect").dispatch("click");
  c.sockets[1].open(); c.sockets[0].end(); c.sockets[0].message({ type: "released" });
  c.sockets[0].message(status({ controller: false, owner: OTHER }));
  c.mode("keyboard"); c.key("keydown", "Space"); c.key("keydown", "KeyW");
  assert.equal(c.last().axes[1], 1); assert.equal(c.timeouts.size, 0);
});

test("a second device is refused: read-only view naming the operator, input ignored", () => {
  const c = controller();
  c.sockets[0].open({ controller: false, you: OTHER, owner: { ...OPERATOR, since_sec: 130 } });
  assert.equal(c.$("overlay").hidden, false);
  assert.equal(c.$("ovTitle").textContent, "ほかの端末（iPhone・10.42.0.23）が操作中です");
  assert.match(c.$("ovSub").textContent, /2 分前から操作しています/);
  assert.equal(c.$("ovWho").textContent, "この端末: iPad・10.42.0.31");
  assert.equal(c.$("requestBtn").hidden, false); assert.equal(c.$("claimBtn").hidden, true);
  assert.equal(c.$("conn").textContent, "閲覧のみ"); assert.equal(c.$("releaseBtn").hidden, true);
  const before = c.joySent().length;
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0); c.heartbeat();
  assert.ok(c.joySent().slice(before).every((m) => m.type !== "joy" || m.axes.every((v) => v === 0)));
  // Asking: the node relays it to the operator.
  c.$("requestBtn").dispatch("click");
  assert.deepEqual(c.joySent().at(-1), { type: "request" });
  c.sockets[0].message({ type: "request_sent", owner: OPERATOR });
  assert.equal(c.$("banner").textContent, "操作中の端末に伝えました");
  // A viewer shows what the operator is sending on its meters.
  c.sockets[0].message(status({ controller: false, owner: OPERATOR, axes: [0, 0.5, 0, -1, 0, 0, 0, 0] }));
  assert.equal(c.$("vFwd").textContent, "+0.50"); assert.equal(c.$("vTurn").textContent, "+1.00");
  // Once the operator lets go, the viewer may take over with 操作する.
  c.sockets[0].message(status({ controller: false, owner: null }));
  assert.equal(c.$("ovTitle").textContent, "いまは誰も操作していません");
  assert.equal(c.$("claimBtn").hidden, false);
  c.$("claimBtn").dispatch("click");
  assert.deepEqual(c.joySent().at(-1), { type: "claim" });
  c.sockets[0].message(status({ controller: true, owner: OTHER }));
  assert.equal(c.$("overlay").hidden, true);
  c.pointer("leftZone", "pointerdown", 5); c.pointer("leftZone", "pointermove", 5, -60, 0);
  assert.equal(c.last().axes[0], 1);
});

test("a viewer's reconnect does not grab the role", () => {
  const c = controller();
  c.sockets[0].open({ controller: false, you: OTHER, owner: OPERATOR });
  c.sockets[0].end(); c.retry();
  assert.match(c.sockets[1].url, /claim=0/);
});

test("losing the role mid-drive clears the input at once", () => {
  const c = controller(); c.sockets[0].open();
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  assert.equal(c.last().axes[0], -1);
  c.sockets[0].message(status({ controller: false, owner: OTHER }));
  neutral(c.last());
  c.pointer("leftZone", "pointermove", 1, 60, 0); c.heartbeat(); neutral(c.last());
});

test("operator releases with 操作をやめる and later reconnects without claiming", () => {
  const c = controller(); c.sockets[0].open();
  c.$("releaseBtn").dispatch("click");
  assert.deepEqual(c.joySent().at(-1), { type: "release" });
  c.sockets[0].message(status({ controller: false, owner: null }));
  assert.equal(c.$("claimBtn").hidden, false);
  c.sockets[0].end(); c.retry();
  assert.match(c.sockets[1].url, /claim=0/);
});

test("hiding the page gives the role up; coming back takes it again if still free", () => {
  const c = controller(); c.sockets[0].open();
  c.document.hidden = true; c.document.dispatch("visibilitychange");
  assert.deepEqual(c.joySent().at(-1), { type: "release" });
  c.sockets[0].message(status({ controller: false, owner: null }));
  c.document.hidden = false; c.document.dispatch("visibilitychange");
  assert.deepEqual(c.joySent().at(-1), { type: "claim" });
  // Someone else took it meanwhile: no claim, the refusal screen instead.
  const d = controller(); d.sockets[0].open();
  d.document.hidden = true; d.document.dispatch("visibilitychange");
  d.sockets[0].message(status({ controller: false, owner: OTHER }));
  d.document.hidden = false; d.document.dispatch("visibilitychange");
  assert.deepEqual(d.joySent().at(-1).type, "joy");
  assert.equal(d.$("ovTitle").textContent, "ほかの端末（iPad・10.42.0.31）が操作中です");
});

test("止める from any page stops the node input and the lesson (drive and roller)", () => {
  const c = controller();
  c.sockets[0].open({ controller: false, you: OTHER, owner: OPERATOR });
  c.$("stop").dispatch("click");
  assert.deepEqual(c.joySent().at(-1), { type: "stop" });
  const [lab] = c.labSockets();
  assert.equal(lab.url, "ws://robot.local:8897/");
  lab.open();
  assert.deepEqual(lab.sent, [{ type: "stop" }, { type: "roller_stop" }]);
  assert.equal(lab.closed, true);
  assert.equal(c.$("banner").className, "ok");
  assert.equal(c.$("banner").textContent, "止めました");
  assert.match(c.$("banner").children[0].textContent, /教材の走行・ローラーを止めました/);
});

test("a failed lesson stop is reported only while a lesson drives", () => {
  const c = controller(); c.sockets[0].open();
  c.sockets[0].message(status({ arbiter: { active: "lab", reason: "lab", lab_locked: false } }));
  assert.equal(c.$("banner").textContent, "教材が走らせています");
  c.$("stop").dispatch("click");
  c.labSockets()[0].end();
  assert.equal(c.$("banner").className, "warn");
  assert.equal(c.$("banner").textContent, "教材の走行を止められませんでした");
  const d = controller(); d.sockets[0].open();
  d.$("stop").dispatch("click"); d.labSockets()[0].end();
  assert.equal(d.$("banner").className, "ok");
  assert.match(d.$("banner").children[0].textContent, /教材の中継は動いていません/);
});

test("the operator stopped by another page lets go of everything", () => {
  const c = controller(); c.sockets[0].open();
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  c.sockets[0].message({ type: "stopped", by: OTHER, by_operator: false });
  neutral(c.last());
  assert.equal(c.$("banner").textContent, "iPad・10.42.0.31 で「止める」が押されました");
  c.pointer("leftZone", "pointermove", 1, 60, 0); c.heartbeat(); neutral(c.last());
});

test("a hand-over request offers 譲る, which releases to the asking page", () => {
  const c = controller(); c.sockets[0].open();
  c.sockets[0].message({ type: "handover_request", from: OTHER });
  assert.equal(c.$("banner").textContent, "iPad・10.42.0.31 が操作したいと言っています");
  const [give] = bannerButtons(c);
  assert.equal(give.textContent, "譲る");
  give.dispatch("click");
  assert.deepEqual(c.joySent().at(-1), { type: "release", to: 2 });
});

test("authentication failure (4401 close) shows the auth screen and does not retry", () => {
  for (const code of [1008, 4401]) {
    const c = controller(); c.sockets[0].end(code); c.retry();
    assert.equal(c.sockets.length, 1);
    assert.equal(c.$("reconnect").hidden, false);
    assert.equal(c.$("ovTitle").textContent, "認証エラー");
    assert.equal(c.$("conn").textContent, "認証エラー");
    c.document.dispatch("visibilitychange"); assert.equal(c.sockets.length, 1);
    c.$("reconnect").dispatch("click"); assert.equal(c.sockets.length, 2);
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

test("camera panel appears only after a frame; newest image wins; joy input intact", () => {
  const c = controller(); c.sockets[0].open(); const img = c.$("camImg");
  const hasCam = () => c.$("app").classList.contains("has-cam");
  // Frames before the node reports a camera (or from an old node) are ignored.
  c.sockets[0].binary(JPEG); assert.equal(img.src, undefined);
  c.sockets[0].message(status({ camera: "waiting" }));
  assert.equal(hasCam(), false);  // subscribed but nothing arrived: no empty panel
  c.sockets[0].message(status({ camera: "live", camera_age_ms: 10 }));
  c.sockets[0].binary(JPEG);
  assert.equal(hasCam(), true); assert.equal(c.$("camBadge").hidden, true);
  assert.equal(img.src, "blob:1"); assert.equal(c.blobs[0].type, "image/jpeg");
  // Still decoding: two more frames arrive, only the last one is shown once decoding ends.
  c.sockets[0].binary(PNG); c.sockets[0].binary(PNG);
  assert.equal(img.src, "blob:1"); assert.equal(c.blobs.length, 1);
  img.onload();
  assert.equal(img.src, "blob:2"); assert.equal(c.blobs[1].type, "image/png"); assert.equal(c.blobs.length, 2);
  img.onload(); assert.deepEqual(c.revoked, ["blob:1"]);
  c.sockets[0].message(status({ camera: "live", camera_age_ms: 10 }));
  assert.equal(c.$("camBadge").hidden, true);
  // Binary traffic must not disturb joy frames or the connection state.
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, -60, 0);
  assert.equal(c.last().axes[0], 1);
  c.sockets[0].message(status({ camera: "stale", camera_age_ms: 4200 }));
  assert.equal(c.$("camBadgeTitle").textContent, "映像が止まっています");
  assert.equal(c.$("camBadgeSub").textContent, "最後の映像から 4 秒");
  c.sockets[0].message(status({ camera: "disabled" }));
  assert.equal(hasCam(), false);
  c.sockets[0].binary(JPEG); assert.equal(c.blobs.length, 2);
});

test("emergency stop outranks the lesson banner", () => {
  const c = controller(); c.sockets[0].open();
  c.sockets[0].message(status({ estop: true, estop_reason: "GPIO", arbiter: { active: "lab" } }));
  assert.equal(c.$("banner").className, "bad"); assert.equal(c.$("banner").textContent, "非常停止中");
  assert.equal(c.$("estop").textContent, "非常停止: 停止中");
  c.sockets[0].message(status({ estop: false, arbiter: { active: "joy" } }));
  assert.equal(c.$("banner").className, "");
});
