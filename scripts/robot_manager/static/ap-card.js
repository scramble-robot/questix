/* Printable connection card: the Wi-Fi QR code of this robot's access point and the QR code of
   the QUESTiX LAB pages. Served by robot_manager (/static/ap-card.html, data from /api/wifi-ap)
   or written as a standalone file by `scripts/wifi-ap.sh card`, which embeds the same data as
   JSON in <script id="card-data">. */

async function loadCardData() {
  const embedded = document.getElementById("card-data");
  if (embedded) return JSON.parse(embedded.textContent);
  const response = await fetch("/api/wifi-ap");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function showMessage(text) {
  const message = document.getElementById("card-message");
  message.textContent = text;
  message.hidden = false;
}

function renderCard(data) {
  if (!data.configured) {
    showMessage("アクセスポイントが未設定です。ロボットで sudo scripts/wifi-ap.sh up を実行してください。");
    return;
  }
  document.title = `QUESTiX 接続カード（${data.ssid}）`;
  document.getElementById("card-title").textContent = data.ssid;
  document.getElementById("card-ssid").textContent = data.ssid;
  document.getElementById("card-password").textContent = data.password;
  document.getElementById("card-url").textContent = data.lab_url;
  document
    .getElementById("wifi-qr")
    .append(qrSvg(wifiQrText(data.ssid, data.password), `Wi-Fi ${data.ssid} に接続するQRコード`));
  document.getElementById("lab-qr").append(qrSvg(data.lab_url, `${data.lab_url} を開くQRコード`));
  document.getElementById("card-steps").hidden = false;
}

document.getElementById("card-print").addEventListener("click", () => window.print());
loadCardData()
  .then(renderCard)
  .catch((error) => showMessage(`設定を読み込めませんでした: ${error.message}`));
