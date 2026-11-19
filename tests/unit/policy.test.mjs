import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../core/classifier.js';
import '../../core/policy.js';

const C = globalThis.MindfulClassifier;
const P = globalThis.MindfulPolicy;

function settings(preset, extra = {}) {
  const s = P.merge(null);
  if (preset) Object.assign(s, P.PRESETS[preset].set);
  return Object.assign(s, extra);
}
function run(title, s, ctx = {}, meta = {}) {
  const m = { id: 'x' + title.length, title, channel: meta.channel || '', kind: 'video', ...meta };
  return P.decide(m, C.classify(m), s, { context: 'home', infoUsed: 0, ...ctx });
}

test('drained: relaxing video shown, lecture shelved, politics hidden', () => {
  const s = settings('drained');
  assert.equal(run('Relaxing piano music for a calm evening', s).action, 'show');
  assert.equal(run('Lecture: Quantum mechanics explained', s, {}, { durationText: '1:10:00' }).action, 'shelf');
  assert.equal(run('Election results: what the president said', s).action, 'hide');
});

test('parasocial and addictive content is hidden by default', () => {
  const s = settings('unwind');
  assert.equal(run('Storytime: my ex exposed me (emotional)', s).action, 'hide');
  assert.equal(run('Last to leave the circle wins $10,000', s).action, 'hide');
});

test('Shorts always hidden when hideShorts', () => {
  const s = settings('laugh');
  assert.equal(run('funny cat', s, {}, { isShort: true }).action, 'hide');
});

test('info budget: second informational video goes to the shelf', () => {
  const s = settings('curious');
  assert.equal(run('Why is the sky blue? Explained', s, { infoUsed: 0 }).action, 'show');
  const d = run('Why is the sky blue? Explained', s, { infoUsed: 1 });
  assert.equal(d.action, 'shelf');
  assert.match(d.reason, /today/);
});

const focusedVariant = i => Object.assign({}, P.PRESETS.focused.ask.options[i].set, { infoBudget: 5 });

test('focused "both": political allowed, deep content allowed', () => {
  const s = settings('focused', focusedVariant(2));
  assert.equal(run('Parliament debate on climate policy – analysis', s).action, 'show');
  assert.equal(run('Full course: linear algebra lecture', s, {}, { durationText: '3:00:00' }).action, 'show');
});

test('focused "apolitical": politics hidden, science shown', () => {
  const s = settings('focused', focusedVariant(0));
  assert.equal(run('Parliament debate on climate policy – analysis', s).action, 'hide');
  assert.equal(run('Full course: linear algebra lecture', s, {}, { durationText: '3:00:00' }).action, 'show');
});

test('focused "only political": non-political learning hidden', () => {
  const s = settings('focused', focusedVariant(1));
  assert.equal(run('Parliament debate on climate policy – analysis', s).action, 'show');
  assert.match(run('Full course: linear algebra lecture', s, {}, { durationText: '3:00:00' }).reason, /not political/);
});

test('focused hides easy videos; drained hides medium ones', () => {
  const f = settings('focused', focusedVariant(2));
  const easy = run('3 Hours of Gentle Rain Sounds for Deep Sleep', f);
  assert.equal(easy.action, 'hide');
  const d = settings('drained');
  assert.notEqual(run('Why do cats purr? Explained', d).action, 'show');
});

test('strict modes: unclassifiable videos are hidden, "unwinding" (any) keeps them', () => {
  assert.equal(run('Untitled 47', settings('lowMotivation')).action, 'hide');
  assert.equal(run('Untitled 47', settings('unwind')).action, 'show');
});

test('"the dangers of believing in nothing" is not shown in "need a lift"', () => {
  assert.equal(run('The dangers of believing in nothing', settings('lowMotivation')).action, 'hide');
});

test('learned feedback: explicit verdicts and learned similarity override soft rules', () => {
  const s = settings('lowMotivation');
  assert.equal(run('Untitled 47', s, { learned: { explicit: 1, verdict: 'yes' } }).action, 'show');
  assert.equal(run('Inspiring story: kindness changed a town', s, { learned: { explicit: -1, verdict: 'no' } }).action, 'hide');
  assert.equal(run('Inspiring story: kindness changed a town', s, { learned: { verdict: 'no', score: -3 } }).action, 'hide');
  assert.equal(run('Untitled 47', s, { learned: { verdict: 'yes', score: 3 } }).action, 'show');
  // hard switches still win over learned similarity
  assert.equal(run('Election results: what the president said', s, { learned: { verdict: 'yes', score: 3 } }).action, 'hide');
});

test('old settings with maxLoad migrate to loads', () => {
  assert.deepEqual(P.merge({ maxLoad: 1 }).loads, [0, 1]);
  assert.deepEqual(P.merge({ maxLoad: 0, loads: [2] }).loads, [2]);
});

test('search results are not filtered by mood (only hard blocks)', () => {
  const s = settings('drained');
  assert.equal(run('Election results analysis', s, { context: 'search' }).action, 'show');
  assert.equal(run('funny', s, { context: 'search' }, { isShort: true }).action, 'hide');
});

test('blocked keyword / channel / topic and trusted channel', () => {
  const s = settings('unwind', { keywordsBlocked: ['minecraft'], channelsBlocked: ['Bad Channel'], topicsBlocked: ['finance'], channelsTrusted: ['Calm Friend'] });
  assert.equal(run('Minecraft but every block is random', s).action, 'hide');
  assert.equal(run('Nice video', s, {}, { channel: 'bad channel' }).action, 'hide');
  assert.equal(run('How to invest in stocks', s).action, 'hide');
  assert.equal(run('Storytime vlog drama', s, {}, { channel: 'Calm Friend' }).action, 'show');
});

test('topicsOnly keeps only chosen topics', () => {
  const s = settings('unwind', { topicsOnly: ['nature'] });
  assert.equal(run('Whales of the deep ocean – wildlife', s).action, 'show');
  assert.equal(run('Funny sketch about gaming nerds', s).action, 'hide');
});

test('paused filter shows everything', () => {
  const s = settings('drained', { enabled: false });
  assert.equal(run('Senator DESTROYS reporter', s).action, 'show');
});

test('shelf: caps, prefers keeping saved items, expires', () => {
  const s = settings(null, { shelfMax: 3, shelfAutoMax: 2 });
  let shelf = [];
  let t = 1000;
  for (const id of ['a', 'b', 'c']) shelf = P.shelfAdd(shelf, { id, source: 'auto' }, s, t++).shelf;
  assert.deepEqual(shelf.map(x => x.id), ['b', 'c']);
  shelf = P.shelfAdd(shelf, { id: 's1', source: 'saved' }, s, t++).shelf;
  const r = P.shelfAdd(shelf, { id: 's2', source: 'saved' }, s, t++);
  assert.equal(r.shelf.length, 3);
  assert.ok(r.shelf.some(x => x.id === 's1') && r.shelf.some(x => x.id === 's2'));
  assert.equal(P.shelfNext(r.shelf, s).id, 's2');
  const day = 86400000;
  const e = P.shelfExpire(r.shelf, s, t + 10 * day);
  assert.ok(e.shelf.every(x => x.source === 'saved'));
  assert.ok(e.letGo.length >= 1);
});
