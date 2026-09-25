/* global qrcode */
"use strict";

// Also exported for URL/QR tests; this module has no server-side effects.
const WebJoyConnection = (() => {
  function parseUrl(raw) {
    const text = raw.trim();
    if (!/^https?:\/\//i.test(text) || text.length > 2048 || /[\s\\]/u.test(text)) {
      throw new Error("http:// または https:// で始まる URL を入力してください。");
    }
    const url = new URL(text);
    if (url.username || url.password || url.port === "0") {
      throw new Error("URL のユーザー名・パスワードやポート 0 は使用できません。");
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") ||
        ["[::1]", "[::]", "0.0.0.0"].includes(host)) {
      throw new Error("localhost ではなく、操作する端末から接続できるロボットの IP アドレスを指定してください。");
    }
    // URL serializes Unicode paths/query to ASCII for the QR byte encoder.
    if (url.href.length > 2048) throw new Error("URL は 2048 文字以内にしてください。");
    return url.href;
  }

  function defaultUrl(pageUrl) {
    try {
      const url = new URL(pageUrl);
      url.protocol = "http:"; // The shipped driver uses HTTP, independent of manager TLS.
      url.port = "8899";
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      url.username = "";
      url.password = "";
      return parseUrl(url.href);
    } catch (_) {
      return ""; // Do not advertise localhost to phones.
    }
  }

  function qrSvg(url, encoder) {
    const code = encoder(0, "M");
    code.addData(parseUrl(url), "Byte");
    code.make();
    return code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  }

  function init() {
    const input = document.getElementById("web-joy-url");
    const status = document.getElementById("web-joy-qr-status");
    const result = document.getElementById("web-joy-qr-result");
    const qr = document.getElementById("web-joy-qr");
    const link = document.getElementById("web-joy-link");
    const browserLink = document.getElementById("web-joy-browser");
    input.value = defaultUrl(location.href);
    function updateBrowserLink() {
      browserLink.hidden = true;
      browserLink.removeAttribute("href");
      try {
        browserLink.href = parseUrl(input.value);
        browserLink.hidden = false;
      } catch (_) { /* Invalid or incomplete URLs cannot be opened. */ }
    }
    function clear() {
      result.hidden = true;
      qr.replaceChildren();
      link.removeAttribute("href");
      status.textContent = "";
      updateBrowserLink();
    }
    updateBrowserLink();
    input.addEventListener("input", clear);
    document.getElementById("web-joy-qr-form").addEventListener("submit", (event) => {
      event.preventDefault();
      clear();
      let url;
      try {
        url = parseUrl(input.value);
      } catch (error) {
        status.textContent = error instanceof TypeError ? "URL の形式を確認してください。" : error.message;
        return;
      }
      try {
        // Only SVG produced by the bundled encoder is inserted; the URL is data.
        qr.innerHTML = qrSvg(url, qrcode);
      } catch (_) {
        status.textContent = "QR を生成できませんでした。URL を短くするか、画面を再読み込みしてください。";
        return;
      }
      input.value = url;
      link.href = url;
      result.hidden = false;
      status.textContent = "接続用 QR を表示しました。";
    });
  }
  return { parseUrl, defaultUrl, qrSvg, init };
})();

if (typeof module !== "undefined") module.exports = WebJoyConnection;
if (typeof document !== "undefined") WebJoyConnection.init();
