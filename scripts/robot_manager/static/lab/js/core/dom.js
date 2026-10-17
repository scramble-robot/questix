// Small DOM helpers shared by course pages.

// Hands the learner a generated file (CSV, script, procedure) without a server round trip.
function downloadFile(name, text, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const formatNumber = (value, digits = 1) => Number(value).toFixed(digits);

// 'smooth' unless the reader asked the system for less motion (DESIGN.md U-8). The CSS rule in
// base.css cannot stop a scroll that a script asks to be smooth, so every script scroll asks here.
function scrollBehavior() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

export { downloadFile, formatNumber, scrollBehavior };
