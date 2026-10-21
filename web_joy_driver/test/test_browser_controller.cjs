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
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.attributes = new Map();
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
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelectorAll() { return this.children.filter((el) => el.tagName === "button"); }
  focus() { if (this.document) this.document.activeElement = this; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  blur() {}
}

const OPERATOR = { id: 1, label: "iPhone", address: "10.42.0.23" };
const OTHER = { id: 2, label: "iPad", address: "10.42.0.31" };

function controller({ matchMedia, initialStatus = true } = {}) {
  const elements = new Map();
  const document = new Element();
  document.hidden = false;
  document.hasFocus = () => true;
  document.documentElement = new Element();
  document.createElement = (tag) => { const e = new Element(tag); e.document = document; return e; };
  document.getElementById = (id) => {
    if (!elements.has(id)) { const e = new Element(); e.document = document; elements.set(id, e); }
    return elements.get(id);
  };
  const $ = document.getElementById;
  $("help").hidden = true;
  document.querySelector = () => $("header");
  document.activeElement = null;
  $("inputMode").value = "pointer";
  const window = new Element();
  if (matchMedia) window.matchMedia = matchMedia;
  const sockets = [], timeouts = new Map(), intervals = [], frames = [];
  let timerId = 0, clock = 0;
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
        if (initialStatus) this.message(status({ controller: welcome.controller, owner: welcome.owner }));
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
    performance: { now: () => clock },
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
    elapse: (ms) => { clock += ms; },
    advance: (ms) => { clock += ms; heartbeat(); },
    last: () => joySent().filter((m) => m.type === "joy").at(-1) };
}

function neutral(frame) {
  assert.equal(frame.type, "joy");
  assert.deepEqual(frame.axes, Array(8).fill(0));
  assert.deepEqual(frame.buttons, Array(14).fill(0));
}
const status = (extra = {}) => ({ type: "status", hold: "active", clients: 1, controller: true, owner: OPERATOR, estop: false, estop_age_ms: 0, stopped: false, ...extra });
const bannerButtons = (c) => c.$("statusActions").children;

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
  c.key("keyup", "KeyW"); c.key("keyup", "Space");
  c.key("keydown", "KeyW"); neutral(c.last());
  c.key("keyup", "KeyW"); c.key("keydown", "Space");
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
  c.key("keyup", "Space"); c.key("keyup", "KeyW");
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
  assert.equal(c.$("bannerTitle").textContent, "ほかの端末が操作中です");
  assert.match(c.$("statusDetail").textContent, /譲る/);
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
  assert.equal(c.$("banner").className, "info");
  assert.equal(c.$("bannerTitle").textContent, "ほかの端末が操作中です");
  assert.match(c.$("statusDetail").textContent, /教材の走行・ローラーを止めました/);
});

test("a failed lesson stop is reported only while a lesson drives", () => {
  const c = controller(); c.sockets[0].open();
  c.sockets[0].message(status({ arbiter: { active: "lab", reason: "lab", lab_locked: false } }));
  assert.equal(c.$("bannerTitle").textContent, "教材から走らせています");
  c.$("stop").dispatch("click");
  c.labSockets()[0].end();
  assert.equal(c.$("banner").className, "warn");
  assert.equal(c.$("bannerTitle").textContent, "教材の走行を止められませんでした");
  const d = controller(); d.sockets[0].open();
  d.$("stop").dispatch("click"); d.labSockets()[0].end();
  assert.equal(d.$("banner").className, "ok");
  assert.match(d.$("statusDetail").textContent, /教材の中継は動いていません/);
});

test("the operator stopped by another page lets go of everything", () => {
  const c = controller(); c.sockets[0].open();
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  c.sockets[0].message({ type: "stopped", by: OTHER, by_operator: false });
  neutral(c.last());
  assert.equal(c.$("bannerTitle").textContent, "ほかの端末で止められました");
  assert.match(c.$("statusDetail").textContent, /iPad・10.42.0.31/);
  c.pointer("leftZone", "pointermove", 1, 60, 0); c.heartbeat(); neutral(c.last());
});

test("a hand-over request offers 譲る, which releases to the asking page", () => {
  const c = controller(); c.sockets[0].open();
  c.sockets[0].message({ type: "handover_request", from: OTHER });
  assert.equal(c.$("bannerTitle").textContent, "操作を代わりたい端末があります");
  assert.match(c.$("statusDetail").textContent, /iPad・10.42.0.31/);
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
  assert.equal(c.$("banner").className, "bad"); assert.equal(c.$("bannerTitle").textContent, "非常停止：押されています");
  assert.equal(c.$("estop").textContent, "非常停止：押されています");
  c.sockets[0].message(status({ estop: false, arbiter: { active: "joy" } }));
  assert.equal(c.$("banner").className, "ok");
});


test("neutral latch status resets held input once and shows then clears its prompt", () => {
  const c = controller(); c.sockets[0].open(); c.mode("keyboard");
  c.key("keydown", "Space"); c.key("keydown", "KeyW"); c.key("keydown", "KeyF");
  c.sockets[0].message(status({ stopped: true, stop_reason: "timeout", hold: "timeout",
    arbiter: { active: "lab" } }));
  neutral(c.last());
  assert.equal(c.$("bannerTitle").textContent, "スティックとボタンから手を離してください");
  c.key("keydown", "KeyF", { repeat: true }); c.heartbeat(); neutral(c.last());
  // A repeated status must not keep resetting a new operation indefinitely.
  c.key("keyup", "Space"); c.key("keyup", "KeyW");
  c.key("keydown", "Space"); c.key("keydown", "KeyW");
  c.sockets[0].message(status({ stopped: true, stop_reason: "timeout" }));
  assert.equal(c.last().axes[1], 1);
  c.sockets[0].message(status({ stopped: false }));
  assert.notEqual(c.$("bannerTitle").textContent, "スティックとボタンから手を離してください");
  c.sockets[0].message(status({ stopped: true, stop_reason: "stop" }));
  neutral(c.last());
  c.sockets[0].message(status({ stopped: true, estop: true }));
  assert.equal(c.$("bannerTitle").textContent, "非常停止：押されています");
});

test("latch reset discards pointer tracking and viewers do not clear their owner's latch", () => {
  const c = controller(); c.sockets[0].open();
  const fire = c.$("buttons").children[1];
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  c.pointer(fire, "pointerdown", 2);
  c.sockets[0].message(status({ stopped: true, stop_reason: "owner_change" }));
  c.pointer("leftZone", "pointermove", 1, -60, 0); c.heartbeat(); neutral(c.last());
  c.sockets[0].message(status({ controller: false, stopped: true }));
  assert.notEqual(c.$("bannerTitle").textContent, "スティックとボタンから手を離してください");
});


test("e-stop display distinguishes unknown causes, exact age boundary and disconnect", () => {
  const c = controller({ initialStatus: false }); c.sockets[0].open();
  assert.equal(c.$("estop").textContent, "非常停止：不明");
  assert.match(c.$("estop").getAttribute("aria-label"), /まだ届いていません/);
  for (const [estop, age, label] of [
    [false, 0, "解除"], [true, 0, "押されています"],
    [false, 1500, "解除"], [true, 1500, "押されています"],
    [false, 1501, "不明"], [true, 1501, "不明"],
    [false, null, "不明"], [false, -1, "不明"], [false, "0", "不明"],
  ]) {
    c.sockets[0].message(status({ estop, estop_age_ms: age }));
    assert.equal(c.$("estop").textContent, "非常停止：" + label);
  }
  c.sockets[0].message(status({ estop_age_ms: 1400 }));
  c.advance(100); assert.equal(c.$("estop").textContent, "非常停止：解除");
  c.advance(1); assert.equal(c.$("estop").textContent, "非常停止：不明");
  assert.match(c.$("estop").getAttribute("aria-label"), /途絶えています/);
  assert.match(c.$("statusDetail").textContent, /途絶えています/);
  assert.equal(c.$("bannerNext").textContent, "先生と周りを確かめてください");
  c.sockets[0].message(status()); c.sockets[0].end();
  assert.equal(c.$("estop").textContent, "非常停止：不明");
  assert.match(c.$("estop").getAttribute("aria-label"), /接続が切れて/);
  c.retry(); c.sockets[1].open();
  assert.match(c.$("estop").getAttribute("aria-label"), /まだ届いていません/);
});

test("pressed or unknown e-stop clears every pointer input and requires fresh presses", () => {
  for (const blocker of [{ estop: true }, { estop: null, estop_age_ms: null }, { estop_age_ms: 1501 }]) {
    const c = controller(); c.sockets[0].open();
    c.pointer("leftZone", "pointerdown", 1); c.pointer("leftZone", "pointermove", 1, 40, -40);
    c.pointer("rightZone", "pointerdown", 2); c.pointer("rightZone", "pointermove", 2, 40, -40);
    c.$("buttons").children.forEach((el, i) => c.pointer(el, "pointerdown", i + 3));
    assert.ok(c.last().axes.some((v) => v !== 0));
    assert.equal(c.last().buttons.filter(Boolean).length, 4);
    let start = c.joySent().length;
    c.sockets[0].message(status(blocker)); c.heartbeat();
    for (const frame of c.joySent().slice(start).filter(m => m.type === "joy")) neutral(frame);
    for (const el of [c.$("leftZone"), c.$("rightZone"), ...c.$("buttons").children]) {
      assert.equal(el.getAttribute("aria-disabled"), "true");
      assert.equal(el.classList.contains("active"), false);
    }
    c.sockets[0].message(status()); start = c.joySent().length;
    c.pointer("leftZone", "pointermove", 1, -60, -60);
    c.pointer("rightZone", "pointermove", 2, -60, -60); c.heartbeat();
    for (const frame of c.joySent().slice(start).filter(m => m.type === "joy")) neutral(frame);
    // A press that starts while disabled cannot become valid on recovery either.
    c.sockets[0].message(status(blocker));
    c.pointer("leftZone", "pointerdown", 10);
    c.$("buttons").children.forEach((el, i) => c.pointer(el, "pointerdown", i + 20));
    c.sockets[0].message(status()); c.pointer("leftZone", "pointermove", 10, 60, 0); c.heartbeat(); neutral(c.last());
    c.pointer("leftZone", "pointerup", 10); c.pointer("leftZone", "pointerdown", 11);
    c.pointer("leftZone", "pointermove", 11, 60, 0); assert.equal(c.last().axes[0], -1);
    c.pointer("leftZone", "pointerup", 11);
    c.$("buttons").children.forEach((el, i) => {
      c.pointer(el, "pointerup", i + 20); c.pointer(el, "pointerdown", i + 30);
      assert.equal(c.last().buttons[[4, 5, 6, 7][i]], 1); c.pointer(el, "pointerup", i + 30);
    });
    neutral(c.last());
  }
});

test("unknown or pressed e-stop discards keyboard holds and invalid key starts", () => {
  for (const blocker of [{ estop: true }, { estop_age_ms: 1501 }, { estop: null }]) {
    const c = controller(); c.sockets[0].open(); c.mode("keyboard");
    c.key("keydown", "Space");
    for (const code of ["KeyW", "KeyQ", "KeyI", "KeyF", "KeyK", "KeyR"]) c.key("keydown", code);
    c.sockets[0].message(status(blocker)); c.heartbeat(); neutral(c.last());
    c.sockets[0].message(status());
    for (const code of ["Space", "KeyW", "KeyF", "KeyR"]) c.key("keydown", code, { repeat: true });
    c.heartbeat(); neutral(c.last());
    c.key("keyup", "Space"); c.key("keydown", "Space");
    c.key("keydown", "KeyW"); neutral(c.last()); // Held action needs its own release too.
    c.key("keyup", "KeyW"); c.key("keydown", "KeyW"); assert.equal(c.last().axes[1], 1);
    c.key("keyup", "Space");
    c.sockets[0].message(status(blocker));
    c.key("keydown", "Space"); c.key("keydown", "KeyA");
    c.sockets[0].message(status());
    c.key("keydown", "Space"); c.key("keydown", "KeyA"); c.heartbeat(); neutral(c.last());
    c.key("keyup", "Space"); c.key("keyup", "KeyA");
    c.key("keydown", "Space"); c.key("keydown", "KeyA"); assert.equal(c.last().axes[0], 1);
  }
});

test("local expiry clears input before heartbeat, despite the WS staying open", () => {
  const c = controller(); c.sockets[0].open();
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  const start = c.joySent().length; c.advance(1501);
  for (const frame of c.joySent().slice(start).filter(m => m.type === "joy")) neutral(frame);
  assert.equal(c.$("leftZone").getAttribute("aria-disabled"), "true");
  c.sockets[0].message(status()); c.pointer("leftZone", "pointermove", 1, -60, 0); c.heartbeat(); neutral(c.last());
});

test("unreceived motion permission does not block page input or invent a neutral wait", () => {
  const c = controller(); c.sockets[0].open(); c.sockets[0].message(status());
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  assert.equal(c.last().axes[0], -1);
  assert.equal(c.$("leftZone").getAttribute("aria-disabled"), "false");
  assert.equal(c.$("bannerTitle").textContent, "この端末から入力できます");
});

test("banner priority puts e-stop before owner, node neutral wait, notices and lesson", () => {
  const c = controller(); c.sockets[0].open();
  c.sockets[0].message({ type: "handover_request", from: OTHER });
  c.sockets[0].message(status({ estop: true, stopped: true, arbiter: { active: "lab" } }));
  assert.equal(c.$("bannerTitle").textContent, "非常停止：押されています");
  c.sockets[0].message(status({ estop: null, stopped: true }));
  assert.equal(c.$("bannerTitle").textContent, "非常停止：不明");
  c.sockets[0].message(status({ controller: false, owner: OTHER, stopped: true }));
  assert.equal(c.$("bannerTitle").textContent, "ほかの端末が操作中です");
  c.sockets[0].message(status({ stopped: true }));
  assert.equal(c.$("bannerTitle").textContent, "スティックとボタンから手を離してください");
  c.sockets[0].message(status({ stopped: false }));
  assert.equal(c.$("bannerTitle").textContent, "操作を代わりたい端末があります");
});

test("help moves and restores focus, supports Escape and leaves stop available", () => {
  const c = controller(); c.sockets[0].open();
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  // The stop belongs to the sheet only while it is open, never under the hidden sheet.
  assert.equal(c.$("helpSheet").getAttribute("aria-owns"), null);
  c.$("helpBtn").dispatch("click"); neutral(c.last());
  assert.equal(c.$("help").hidden, false); assert.equal(c.document.activeElement, c.$("helpSheet"));
  assert.equal(c.$("helpSheet").getAttribute("aria-owns"), "stop");
  c.pointer("leftZone", "pointerdown", 2); c.pointer("leftZone", "pointermove", 2, 60, 0); c.heartbeat(); neutral(c.last());
  c.key("keydown", "Tab"); assert.equal(c.document.activeElement, c.$("stop"));
  c.$("stop").dispatch("click"); assert.deepEqual(c.joySent().at(-1), { type: "stop" });
  c.key("keydown", "Escape"); assert.equal(c.$("help").hidden, true);
  assert.equal(c.document.activeElement, c.$("helpBtn"));
  assert.equal(c.$("helpSheet").getAttribute("aria-owns"), null);
  c.$("bannerDetails").dispatch("click"); c.$("helpClose").dispatch("click");
  assert.equal(c.document.activeElement, c.$("bannerDetails"));
});

test("initial mode aria-pressed, modal semantics, age wording and 12px font floor", () => {
  const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
  assert.match(html, /id="modePointer"[^>]*aria-pressed="true"/);
  assert.match(html, /id="modeKeyboard"[^>]*aria-pressed="false"/);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
  assert.doesNotMatch(html, /aria-owns=/);  // set only while the help sheet is open
  assert.doesNotMatch(html, /font(?:-size)?\s*:[^;{}]*?\b(?:9|10|11)px/);
  assert.match(html, /user-scalable=no/);
  const c = controller(); c.sockets[0].open(); c.sockets[0].message(status({ rx_age_ms: 47 }));
  assert.match(c.$("dbgStat").textContent, /受信からの経過時間 47ms/);
  assert.doesNotMatch(c.$("dbgStat").textContent, /遅延/);
  c.mode("keyboard"); assert.equal(c.$("modeKeyboard").getAttribute("aria-pressed"), "true");
});


test("a queued animation frame cannot send held input after age expires", () => {
  const c = controller(); c.sockets[0].open();
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  c.elapse(1501);
  const start = c.joySent().length;
  c.pointer("rightZone", "pointerdown", 2); // Disabled start, even before the timer runs.
  c.pointer("leftZone", "pointermove", 1, 40, 0); c.flush();
  const sent = c.joySent().slice(start).filter(m => m.type === "joy");
  assert.ok(sent.length > 0);
  sent.forEach(neutral);
});

test("neutral-wait fallback lasts only until discarded presses end when peer omits latch", () => {
  const c = controller(); c.sockets[0].open();
  const legacy = (extra = {}) => status({ stopped: undefined, ...extra });
  c.sockets[0].message(legacy());
  c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
  c.sockets[0].message(legacy({ estop: true })); c.sockets[0].message(legacy());
  assert.equal(c.$("bannerTitle").textContent, "スティックとボタンから手を離してください");
  c.pointer("leftZone", "pointerup");
  assert.equal(c.$("bannerTitle").textContent, "この端末から入力できます");
  c.mode("keyboard"); c.key("keydown", "Space"); c.key("keydown", "KeyW");
  c.sockets[0].message(legacy({ estop: null })); c.sockets[0].message(legacy());
  c.key("keyup", "Space");
  assert.equal(c.$("bannerTitle").textContent, "スティックとボタンから手を離してください");
  c.key("keyup", "KeyW");
  assert.equal(c.$("bannerTitle").textContent, "この端末から入力できます");
  c.sockets[0].message(legacy({ estop: true }));
  c.pointer("leftZone", "pointerdown", 3); c.sockets[0].message(legacy());
  assert.equal(c.$("bannerTitle").textContent, "スティックとボタンから手を離してください");
  c.document.dispatch("pointerup", { pointerId: 3 });
  assert.equal(c.$("bannerTitle").textContent, "この端末から入力できます");
});


test("scroll or resize discards held input before its reference rectangle changes", () => {
  for (const type of ["scroll", "resize"]) {
    const c = controller(); c.sockets[0].open();
    c.pointer("leftZone", "pointerdown"); c.pointer("leftZone", "pointermove", 1, 60, 0);
    c.pointer(c.$("buttons").children[1], "pointerdown", 2);
    c.window.dispatch(type); neutral(c.last());
    c.pointer("leftZone", "pointermove", 1, -60, 0); c.heartbeat(); neutral(c.last());
  }
});
