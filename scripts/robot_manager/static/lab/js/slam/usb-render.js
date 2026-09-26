import { roleStyle } from '../core/palette.js';

export function drawUsbGrid(canvas, snapshot, spanMetres = null) {
  const context = canvas.getContext('2d');
  const image = context.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < canvas.width * canvas.height; i++) {
    let index = i;
    if (snapshot && spanMetres) {
      const x = (i % canvas.width) - canvas.width / 2;
      const y = Math.floor(i / canvas.width) - canvas.height / 2;
      const ratio = spanMetres / canvas.width / snapshot.resolution;
      const column = Math.floor(
        snapshot.size / 2 + snapshot.pose.x / snapshot.resolution + x * ratio,
      );
      const row = Math.floor(snapshot.size / 2 - snapshot.pose.y / snapshot.resolution + y * ratio);
      index =
        column < 0 || column >= snapshot.size || row < 0 || row >= snapshot.size
          ? -1
          : row * snapshot.size + column;
    }
    const evidence = snapshot?.grid[index] ?? 0;
    let color = 190;
    if (evidence >= 3) color = 45;
    else if (evidence <= -2) color = 250;
    image.data.set([color, color, color, 255], i * 4);
  }
  context.putImageData(image, 0, 0);
}
export function drawUsbMap(canvas, snapshot, spanMetres = 8) {
  drawUsbGrid(canvas, snapshot, spanMetres);
  if (!snapshot) return;
  const context = canvas.getContext('2d');
  const scale = canvas.width / spanMetres;
  const point = (pose) => [
    canvas.width / 2 + (pose.x - snapshot.pose.x) * scale,
    canvas.height / 2 - (pose.y - snapshot.pose.y) * scale,
  ];
  context.strokeStyle = roleStyle('measured').color;
  context.lineWidth = 3;
  context.beginPath();
  snapshot.path.forEach((pose, i) => {
    if (i) context.lineTo(...point(pose));
    else context.moveTo(...point(pose));
  });
  context.stroke();
  context.save();
  context.translate(...point(snapshot.pose));
  context.rotate(-snapshot.pose.theta);
  context.fillStyle = roleStyle('measured').color;
  context.beginPath();
  context.moveTo(12, 0);
  context.lineTo(-8, -7);
  context.lineTo(-8, 7);
  context.closePath();
  context.fill();
  context.restore();
}
export function drawUsbScan(canvas, points) {
  const context = canvas.getContext('2d');
  const centre = canvas.width / 2;
  context.fillStyle = '#f4f6f8';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = roleStyle('measured').color;
  for (const point of points)
    context.fillRect(
      centre + (point.x * centre) / 12 - 2,
      centre - (point.y * centre) / 12 - 2,
      4,
      4,
    );
  context.fillRect(centre - 4, centre - 4, 8, 8);
}
