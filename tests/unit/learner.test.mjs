import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../core/classifier.js';
import '../../core/learner.js';

const L = globalThis.MindfulLearner;
const C = globalThis.MindfulClassifier;
const v = (id, title, channel = '') => ({ id, title, channel });

test('features: stop words dropped, plurals stemmed, pairs and channel included', () => {
  const f = L.features(v('a', 'The dangers of believing in nothing', 'Deep Thoughts'));
  assert.ok(f.includes('w:danger'));
  assert.ok(f.includes('w:believing'));
  assert.ok(!f.includes('w:the') && !f.includes('w:of'));
  assert.ok(f.includes('b:danger_believing'));
  assert.ok(f.includes('c:deep thoughts'));
});

test('explicit verdict for the same video wins; flipping an answer undoes the old one', () => {
  const m = L.empty();
  L.feedback(m, v('a', 'The dangers of believing in nothing'), 'inspire', false, []);
  assert.equal(L.judge(m, v('a', 'The dangers of believing in nothing'), 'inspire').verdict, 'no');
  L.feedback(m, v('a', 'The dangers of believing in nothing'), 'inspire', true, []);
  const j = L.judge(m, v('a', 'The dangers of believing in nothing'), 'inspire');
  assert.equal(j.explicit, 1);
  assert.ok(j.score > 0, 'weights moved to positive, not double-counted negative: ' + j.score);
});

test('similar videos follow feedback (shared words / channel), unrelated ones do not', () => {
  const m = L.empty();
  L.feedback(m, v('a', 'The dangers of believing in nothing', 'Deep Thoughts'), 'inspire', false, []);
  assert.equal(L.judge(m, v('b', 'Believing in nothing: the hidden dangers'), 'inspire').verdict, 'no');
  assert.equal(L.judge(m, v('c', 'A new talk', 'Deep Thoughts'), 'inspire').verdict, null, 'channel alone (1.5) is below threshold');
  assert.equal(L.judge(m, v('d', 'Puppies playing in the snow'), 'inspire').verdict, null);
  // feedback is per mode
  assert.equal(L.judge(m, v('b', 'Believing in nothing: the hidden dangers'), 'learn').verdict, null);
});

test('reasons teach shared dimensions that adjust the classifier profile in every mode', () => {
  const m = L.empty();
  L.feedback(m, v('a', 'Why nothing you do will ever be enough'), 'inspire', false, ['heavy']);
  const similar = v('b', 'Nothing you do is ever enough');
  const j = L.judge(m, similar, 'relax');
  assert.equal(j.dims.heavy, true);
  const p = L.adjustProfile(C.classify(similar), j);
  assert.equal(p.tone, 'heavy');
});

test('examplesForAi exposes readable feedback', () => {
  const m = L.empty();
  L.feedback(m, v('a', 'X video', 'Ch'), 'inspire', false, ['heavy'], '🌱 Need a lift');
  const ex = L.examplesForAi(m, 5);
  assert.equal(ex.length, 1);
  assert.deepEqual(ex[0], { title: 'X video', channel: 'Ch', mode: '🌱 Need a lift', fits: false, reasons: ['Too heavy / dark'] });
});

test('load() tolerates missing or partial state', () => {
  assert.deepEqual(L.load(null).modes, {});
  assert.equal(L.load({ count: 3, modes: { relax: { 'w:rain': 1 } } }).modes.relax['w:rain'], 1);
});

const MOODS = [{ key: 'drained', label: 'Drained' }, { key: 'laugh', label: 'Need a laugh' }, { key: 'sleep', label: 'Sleep' }];

test('sortVideo: selected moods fit, unselected do not; answers can be revised without stacking', () => {
  const m = L.empty();
  const vid = v('s1', 'Cozy cabin rain ambience', 'Calm Place');
  L.sortVideo(m, vid, ['drained', 'sleep'], MOODS);
  assert.equal(m.videos.s1.drained, 1);
  assert.equal(m.videos.s1.sleep, 1);
  assert.equal(m.videos.s1.laugh, -1);
  assert.equal(L.isSorted(m, 's1'), true);
  const once = L.judge(m, v('x', 'Cozy cabin rain sounds'), 'drained').score;
  L.sortVideo(m, vid, ['drained', 'sleep'], MOODS);
  assert.equal(L.judge(m, v('x', 'Cozy cabin rain sounds'), 'drained').score, once, 'same answer twice does not double the weights');
  L.sortVideo(m, vid, ['laugh'], MOODS);
  assert.equal(m.videos.s1.drained, -1);
  assert.equal(m.videos.s1.laugh, 1);
});

test('fits-no-mood pile and never-show', () => {
  const m = L.empty();
  L.markNoMood(m, v('n1', 'Train cab ride through the Alps', 'Rail Cam'), MOODS);
  assert.deepEqual(L.noMoodVideos(m).map(x => x.id), ['n1']);
  const j = L.judge(m, v('n1', 'Train cab ride through the Alps'), 'laugh');
  assert.equal(j.nomood, true);
  assert.equal(j.explicit, -1);
  // putting it into a (new) mood takes it off the pile
  L.feedback(m, v('n1', 'Train cab ride through the Alps', 'Rail Cam'), 'mood_trains', true, [], '🚆 Trains');
  assert.deepEqual(L.noMoodVideos(m), []);
  assert.equal(L.judge(m, v('n2', 'Cab ride: the Alps by train'), 'mood_trains').verdict, 'yes', 'similar videos join the new mood');

  L.markNever(m, v('bad', 'Something'));
  assert.equal(L.judge(m, v('bad', 'Something'), 'laugh').never, true);
});

test('migrateToMoods copies need-based learning to the moods that use that need', () => {
  const m = L.load({ v: 1, count: 1, modes: { relax: { 'w:rain': 2 } }, videos: { a: { relax: 1 } } });
  L.migrateToMoods(m, { drained: { set: { need: 'relax' } }, sleep: { set: { need: 'relax' } }, laugh: { set: { need: 'laugh' } } });
  assert.equal(m.modes.drained['w:rain'], 2);
  assert.equal(m.modes.sleep['w:rain'], 2);
  assert.equal(m.videos.a.sleep, 1);
  assert.equal(m.modes.laugh, undefined);
  assert.equal(m.v, 2);
});
