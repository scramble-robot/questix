// Escapes text for the HTML strings that other courses embed with unsafeHTML or innerHTML.
// lit-html templates escape their own interpolations; this is only for string-returning helpers.

const ESCAPED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPED[char]);

export { escapeHtml };
