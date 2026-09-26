// Lesson content lives outside the code, under content/: texts and settings as JSON, downloadable
// ROS 2 scripts and procedures as the real files learners receive. Modules load what they need
// once at start-up with top-level await, so the rest of the code keeps using plain constants.

const ROOT = new URL('../../', import.meta.url);
const IN_BROWSER = typeof window !== 'undefined';

async function read(path, kind) {
  const url = new URL(path, ROOT);
  if (!IN_BROWSER) {
    // Node (tests, tooling): fetch() cannot read file: URLs.
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(url);
    return kind === 'bytes' ? new Uint8Array(bytes) : bytes.toString('utf8');
  }
  const response = await fetch(url);
  if (!response.ok) throw Error(`教材のデータを読み込めませんでした：${path}`);
  return kind === 'bytes' ? new Uint8Array(await response.arrayBuffer()) : response.text();
}

const loadText = (path) => read(path, 'text');
const loadJson = async (path) => JSON.parse(await read(path, 'text'));
const contentUrl = (path) => new URL(path, ROOT).href;

export { loadText, loadJson, contentUrl };
