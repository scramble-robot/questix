function measurementStats(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v))) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    n: values.length,
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    sd: Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length),
  };
}
function fitMeasurement(rows) {
  const train = rows.filter((r) => !r.test),
    check = rows.filter((r) => r.test);
  if (train.length < 2 || rows.some((r) => !Number.isFinite(r.x) || !Number.isFinite(r.y)))
    return null;
  const x = measurementStats(train.map((r) => r.x)).mean,
    y = measurementStats(train.map((r) => r.y)).mean,
    variance = train.reduce((s, r) => s + (r.x - x) ** 2, 0);
  if (variance < 1e-9) return null;
  const slope = train.reduce((s, r) => s + (r.x - x) * (r.y - y), 0) / variance,
    intercept = y - slope * x,
    min = Math.min(...train.map((r) => r.x)),
    max = Math.max(...train.map((r) => r.x));
  const predictions = check.map((r) => ({
    ...r,
    predicted: slope * r.x + intercept,
    error: slope * r.x + intercept - r.y,
    inside: r.x >= min && r.x <= max,
  }));
  return {
    slope,
    intercept,
    min,
    max,
    predictions,
    mae: predictions.length
      ? measurementStats(predictions.map((r) => Math.abs(r.error))).mean
      : null,
  };
}
function parseMeasurementCSV(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#'));
  if (lines[0]?.toLowerCase().replace(/\s/g, '') === 'x,y,test') lines.shift();
  if (!lines.length || lines.length > 200)
    throw new Error('1〜200行の x,y,test のデータを使ってください。');
  return lines.map((line, i) => {
    const v = line.split(',').map((s) => s.trim());
    if (
      v.length < 2 ||
      v.length > 3 ||
      v.slice(0, 2).some((s) => !s || !Number.isFinite(Number(s))) ||
      (v[2] && !['0', '1'].includes(v[2]))
    )
      throw new Error(
        i + 1 + '行目を確認してください。数値2列と、確認用なら1（それ以外0）を使います。',
      );
    return { x: Number(v[0]), y: Number(v[1]), test: v[2] === '1' };
  });
}

export { measurementStats, fitMeasurement, parseMeasurementCSV };
