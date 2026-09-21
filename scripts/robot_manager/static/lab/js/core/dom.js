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

export { downloadFile, formatNumber };
