/* QR codes as SVG, built with DOM calls so the manager's strict CSP (no inline styles, no data:
   images) still allows them. Needs vendor/qrcode.js (global `qrcode`). Shared by app.js (教材 tab)
   and ap-card.js (printable card). */

const QR_QUIET_ZONE = 4; // modules of white border required around a QR code

// Standard Wi-Fi QR payload: phone cameras (iOS 11+, Android 10+) offer to join the network.
function wifiQrText(ssid, password) {
  const escape = (value) => value.replace(/[\;,:"]/g, (c) => "\\" + c);
  return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;`;
}

// One <path> for all dark modules keeps the SVG small; error correction M survives smudges on a
// printed card.
function qrSvg(text, label) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + QR_QUIET_ZONE * 2;
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h1v1h-1z`;
    }
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", size);
  background.setAttribute("height", size);
  background.setAttribute("fill", "#fff");
  const modules = document.createElementNS(ns, "path");
  modules.setAttribute("d", d);
  modules.setAttribute("fill", "#000");
  svg.append(background, modules);
  return svg;
}
