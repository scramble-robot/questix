const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseUrl, defaultUrl, qrSvg } = require("../static/web-joy-connection.js");
const qrcode = require("../static/qrcode.js");

test("robot URL preserves encoded token and supports IPv6", () => {
  const url = "http://192.168.1.2:8899/?token=a%2Bb%26c";
  assert.equal(parseUrl(` ${url} `), url);
  assert.equal(parseUrl("http://[fd00::1]:8899/"), "http://[fd00::1]:8899/");
  assert.equal(parseUrl("https://robot.local/操作?token=あ"),
    "https://robot.local/%E6%93%8D%E4%BD%9C?token=%E3%81%82");
});

test("QR never points at phone loopback or executes a non-web scheme", () => {
  for (const url of ["", "javascript:alert(1)", "file:///etc/passwd", "//robot/", "http://",
    "http://localhost:8899/", "http://localhost./", "http://127.1/", "http://[::1]/",
    "http://user:pass@robot/", "http://robot:0/", "http://robot:65536/", "http://robot\\@other/",
    "http://robot/\npath"]) assert.throws(() => parseUrl(url), undefined, url);
});

test("manager origin suggests robot HTTP endpoint without inheriting secrets", () => {
  assert.equal(defaultUrl("https://robot.local:8888/manage?token=private#rec"), "http://robot.local:8899/");
  assert.equal(defaultUrl("http://[fd00::2]:8888/"), "http://[fd00::2]:8899/");
  assert.equal(defaultUrl("http://127.0.0.1:8888/"), "");
});

test("bundled encoder renders local QR", () => {
  const svg = qrSvg("http://192.168.1.2:8899/?token=abc", qrcode);
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox=/);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject/i);
});

test("browser link works without QR generation and never keeps a stale URL", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: "", hidden: false, listeners: {},
        addEventListener(type, callback) { this.listeners[type] = callback; },
        removeAttribute(name) { delete this[name]; },
        replaceChildren() {},
      });
      return elements.get(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/web-joy-connection.js"), "utf8"), {
    document, URL, location: { href: "http://robot.local:8888/" },
    qrcode() { throw new Error("QR unavailable"); },
  });
  const input = elements.get("web-joy-url");
  const link = elements.get("web-joy-browser");
  assert.equal(link.href, "http://robot.local:8899/");
  assert.equal(link.hidden, false);
  input.value = "https://robot.local/joy?token=a%2Bb%26c";
  input.listeners.input();
  assert.equal(link.href, input.value);
  assert.equal(elements.get("web-joy-qr-result").hidden, true);
  elements.get("web-joy-qr-form").listeners.submit({ preventDefault() {} });
  assert.equal(link.hidden, false); // QR failure must not block the direct browser link.
  input.value = "javascript:alert(1)";
  input.listeners.input();
  assert.equal(link.hidden, true);
  assert.equal(link.href, undefined);
});
