import {
  World,
  Trainer,
  rollout,
  DEFAULT_REWARD,
  DEFAULT_PHYSICS,
  summarizeEvaluation,
} from '../core/engine.js';

const clone = (value) => structuredClone(value);
function initialConfig(task = 'delivery', course = 'standard') {
  return {
    task,
    course,
    startMode: 'near',
    rewards: clone(DEFAULT_REWARD),
    physics: { ...DEFAULT_PHYSICS, course },
  };
}
function newSeeds(count = 20) {
  return [...crypto.getRandomValues(new Uint32Array(count))];
}
function evaluate(config, weights, seed, { random = true } = {}) {
  return rollout(new World(config.task, config.rewards, config.physics), weights, seed, {
    other: random,
    capture: true,
  });
}
function resultName(result) {
  return result.success
    ? '到着'
    : result.collision
      ? '接触'
      : result.emergency
        ? '衝撃で停止'
        : result.wrongAngle
          ? '向きが合わない'
          : '時間切れ';
}
function statistics(results) {
  const summary = summarizeEvaluation(results);
  return {
    ...summary,
    contacts: results.filter((r) => r.collision).length,
    cleared:
      results.length === 20 &&
      summary.successCount >= 16 &&
      results.filter((r) => r.collision).length <= 2,
  };
}
// A run owns immutable settings and policy snapshots. Draft edits never change a replay.
class Experiment {
  constructor(task = 'delivery', course = 'standard') {
    this.draft = initialConfig(task, course);
    this.run = null;
    this.previous = null;
    this.records = [];
    this.revision = 1;
    this.change = '最初の設定';
    this.note = '';
    this.pendingRevision = false;
    this.reflection = { choice: '', note: '' };
  }
  prepareRevision(change, note = '') {
    if (this.run?.results.length === 20) this.previous = clone(this.run);
    this.change = change;
    this.note = note;
    if (!this.pendingRevision) this.revision++;
    this.pendingRevision = true;
  }
  async train(onProgress = () => {}, isCancelled = () => false) {
    if (this.run && !this.pendingRevision) this.prepareRevision('条件を見直して再学習');
    if (this.run) {
      const before = this.previous?.config || this.run.config,
        changes = [];
      if (before.startMode !== this.draft.startMode)
        changes.push(
          '学習の開始位置を' +
            (this.draft.startMode === 'varied' ? '広げる' : '同じ場所の近くにする'),
        );
      for (const r of REWARDS) {
        const a = before.rewards,
          b = this.draft.rewards;
        if (a.enabled[r.key] !== b.enabled[r.key])
          changes.push(r.name + 'を' + (b.enabled[r.key] ? '有効' : '無効') + 'にする');
        else if (b.enabled[r.key] && a[r.key] !== b[r.key])
          changes.push(r.name + '：' + a[r.key] + ' → ' + b[r.key]);
      }
      this.change = changes.join(' / ') || '同じ条件で最初から再学習';
    }
    const config = clone(this.draft),
      trainer = new Trainer(config.task, config.rewards, config.physics, 42, {
        startMode: config.startMode,
      });
    const checkpoints = [
      {
        label: '学習前',
        episodes: 0,
        result: evaluate(config, trainer.weights, 100, { random: false }),
      },
    ];
    for (let i = 0; i < 160; i++) {
      if (isCancelled()) return null;
      trainer.iteration();
      if (i === 79 || i === 159)
        checkpoints.push({
          label: i === 79 ? '途中' : '学習後',
          episodes: trainer.episodes,
          result: evaluate(config, trainer.bestWeights, 100, { random: false }),
        });
      onProgress({
        episodes: trainer.episodes,
        iterations: trainer.iterations,
        history: clone(trainer.history),
        checkpoints,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const run = {
      config,
      weights: trainer.bestWeights.slice(),
      episodes: trainer.episodes,
      history: clone(trainer.history),
      checkpoints,
      seeds: this.previous ? [...this.previous.seeds] : newSeeds(),
      results: [],
      revision: this.revision,
      change: this.change,
      note: this.note,
    };
    this.run = run;
    this.pendingRevision = false;
    this.reflection = { choice: '', note: '' };
    return run;
  }
  testOne(index) {
    const run = this.run;
    if (!run) throw new Error('Train before testing');
    const result = evaluate(run.config, run.weights, run.seeds[index]);
    run.results[index] = result;
    return result;
  }
  record() {
    if (this.run?.results.length !== 20) return;
    if (!this.records.some((r) => r.revision === this.run.revision))
      this.records.push(clone(this.run));
  }
  freshTest() {
    this.previous = null;
    this.run = { ...this.run, seeds: newSeeds(), results: [] };
  }
}

const REWARDS = [
  {
    key: 'success',
    name: '到着して停止',
    unit: '点 / 回',
    sign: '＋',
    max: 200,
    step: 10,
    description:
      '黄色の目標範囲で0.5秒止まると、1回だけ加点します。充電ポートの課題では、向きのずれも8°以内にそろえます。',
  },
  {
    key: 'progress',
    name: '目標へ近づく',
    unit: '点 / m',
    sign: '＋',
    max: 60,
    step: 5,
    description:
      '1 m近づいたときの点数です。25点 / mなら20 cm近づいて5点、20 cm離れて5点減点です。終了時は、残り距離にも設定値の0.32倍を掛けて減点します。',
  },
  {
    key: 'collision',
    name: '壁や障害物に接触',
    unit: '点 / 回',
    sign: '−',
    max: 150,
    step: 10,
    description: '接触したら減点します。走行はそこで終了します。',
  },
  {
    key: 'time',
    name: '時間がかかる',
    unit: '点 / 秒',
    sign: '−',
    max: 8,
    step: 0.5,
    description:
      '経過した時間に応じて減点します。1点 / 秒なら10秒で10点減点です。早く着くほど、この減点を少なくできます。',
  },
  {
    key: 'clearance',
    name: '障害物に近づきすぎる',
    unit: '点 / 秒（最大）',
    sign: '−',
    max: 20,
    step: 1,
    description:
      '周囲の距離を測るLiDARの値から、車体の外側と障害物の間隔を求めます。40 cm未満で減点が始まり、近づくほど増えます。「最大4点 / 秒」なら、20 cmでは1点 / 秒の減点です。',
  },
  {
    key: 'careful',
    name: '速い旋回・後退',
    unit: '倍',
    sign: '−',
    max: 10,
    step: 0.5,
    description:
      '速く向きを変えたり、後ろへ進んだりすると減点します。設定値はその減点を何倍にするかで、2倍なら同じ動きへの減点が2倍です。車輪の急な加速や、車体の揺れを直接評価する項目ではありません。',
  },
  {
    key: 'settling',
    name: '目標の中で減速',
    unit: '点 / 秒（最大）',
    sign: '＋',
    max: 5,
    step: 0.1,
    description:
      '目標の範囲内で、前後へ進む速度が小さいほど加点します。その速度が0のときに「最大」の点数になります。目標へ近づいた後、その場で減速する手がかりにします。',
  },
  {
    key: 'heading',
    name: '充電ポートに向きを合わせる',
    unit: '点 / rad（最大）',
    sign: '＋',
    max: 20,
    step: 1,
    description:
      'ポートの近くで正しい向きへ回ると加点し、向きが離れると減点します。radは角度の単位で、1 radは約57°です。同じ角度を直しても、遠い場所ほど点数は小さくなります。終了時に残った向きのずれも減点します。',
    dock: true,
  },
  {
    key: 'moving',
    name: '動いている時間',
    unit: '点 / 秒',
    sign: '＋',
    max: 20,
    step: 1,
    description:
      '前後へ毎秒6 cmより速く進んでいる間、時間に応じて加点します。目標から離れる動きでも点数が付くため、到着より動き続けることを優先しないか確かめる項目です。',
  },
  {
    key: 'near',
    name: '目標の近くにいる時間',
    unit: '点 / 秒',
    sign: '＋',
    max: 20,
    step: 1,
    description:
      '機体の中心が目標から60 cm以内にいる間、時間に応じて加点します。到着の範囲で止まらなくても点数が増えるため、近くに居続ける走りにならないか確かめます。',
  },
];

export { clone, initialConfig, newSeeds, evaluate, resultName, statistics, Experiment, REWARDS };
