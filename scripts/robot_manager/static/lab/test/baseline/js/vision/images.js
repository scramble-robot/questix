function makeVisionImage({
  kind = 0,
  color = 'red',
  light = 1,
  variant = 0,
  clutter = false,
} = {}) {
  const width = 320,
    height = 220,
    data = new Uint8ClampedArray(width * height * 4),
    cx = 155 + ((variant % 3) - 1) * 14,
    cy = 126 + (variant % 2) * 4,
    size = 48 + (variant % 4) * 3;
  const paint = (x, y) => {
    const dx = x - cx,
      dy = y - cy,
      inside =
        kind === 0 ? Math.abs(dx) < size && Math.abs(dy) < size : dx * dx + dy * dy < size * size;
    const ground = y > 80,
      grid = ground && (y % 35 === 0 || Math.abs(((x - 160) / (y - 50)) * 70) % 50 < 1.2);
    let base = ground ? (grid ? 159 : 179) : 204;
    let rgb = [base, base + 3, base + 4];
    if (inside) {
      const shade =
        kind === 0
          ? dx > size * 0.6
            ? 0.8
            : 1
          : 0.55 + 0.4 * Math.sqrt(Math.max(0, 1 - (dx * dx + dy * dy) / (size * size)));
      rgb = (
        color === 'blue' ? [46, 113, 209] : color === 'green' ? [63, 158, 103] : [213, 77, 53]
      ).map((v) => v * shade);
      if (kind === 0 && (Math.abs(dx) < 4 || dy < -size + 7)) rgb = rgb.map((v) => v * 0.8);
    }
    if (clutter && x > 258 && x < 298 && y > 42 && y < 76) rgb = [200, 68, 50];
    return rgb;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4,
        noise = (((x * 13 + y * 7 + variant) % 7) - 3) * 0.5;
      paint(x, y).forEach((v, i) => (data[k + i] = Math.max(0, Math.min(255, v * light + noise))));
      data[k + 3] = 255;
    }
  return { width, height, data };
}
function visionTestSet() {
  return Array.from({ length: 10 }, (_, i) => ({
    id: 'test-' + i,
    label: i % 2,
    condition: i < 4 ? 'いつもの色' : i < 8 ? '色を入れ替え' : '暗い場所',
    image: makeVisionImage({
      kind: i % 2,
      color: (i < 4 ? i % 2 === 0 : i % 2 !== 0) ? 'red' : 'blue',
      light: i >= 8 ? 0.6 : 1,
      variant: 10 + i,
    }),
  }));
}

export { makeVisionImage, visionTestSet };
