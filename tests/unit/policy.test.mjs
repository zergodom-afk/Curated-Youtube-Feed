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

test('focused: political allowed, deep content allowed', () => {
  const s = settings('focused', { infoBudget: 5 });
  assert.equal(run('Parliament debate on climate policy – analysis', s).action, 'show');
  assert.equal(run('Full course: linear algebra lecture', s, {}, { durationText: '3:00:00' }).action, 'show');
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
