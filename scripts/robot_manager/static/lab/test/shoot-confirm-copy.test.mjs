import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const copy = JSON.parse(readFileSync(new URL('../content/live/shoot.json', import.meta.url), 'utf8'));
test('all three confirmation sentences allow spinning without loading a disc', () => {
  for (const sentence of [copy.confirm, copy.reconfirm.fired, copy.reconfirm.stopped]) {
    assert.match(sentence, /発射する方向と的の周りに人がいないこと/);
    assert.match(sentence, /ディスクを入れるときは1枚だけにしたことを確かめ/);
    assert.doesNotMatch(sentence, /ディスクを1枚だけ入れた/);
  }
});
