import { contentUrl } from '../core/content.js';

// AI-generated teaching room, not a captured robot image. See docs/vision-scene-provenance.md.
// The PNG is decoded once at start-up without colour conversion, so lessons get its exact pixels.
const SCENE_URL = contentUrl('assets/vision/floor-scene.png');

async function decodeScene() {
  const response = await fetch(SCENE_URL);
  if (!response.ok) throw Error('教材画像を読み込めませんでした。');
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}
const scene = await decodeScene();

// Lessons modify the pixels they receive, so every call hands out a fresh copy.
function floorSceneImage() {
  return { width: scene.width, height: scene.height, data: new Uint8ClampedArray(scene.data) };
}

export { floorSceneImage };
