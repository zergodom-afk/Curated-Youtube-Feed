import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../core/classifier.js';
import '../../core/profile.js';

const C = globalThis.MindfulClassifier;
const Pr = globalThis.MindfulProfile;

const answers = {
  easy: ['gaming', 'music'], hard: ['essays', 'podcasts'], strain: ['emotional', 'long'], lengthMin: 20,
  lowPref: 'match', newsFeel: 'tense', companyFeel: 'comfort',
  moods: ['drained', 'curious', 'focused'],
  perMood: {
    drained: { like: ['music', 'gaming'], avoid: ['news', 'music'], maxMinutes: 20, likeWords: 'stardew, lofi', avoidWords: 'true crime' },
    curious: { like: ['curiosity'], avoid: [], maxMinutes: 0 },
  },
};

test('build: calibration, per-mood profiles and overrides follow the answers', () => {
  const b = Pr.build(answers);
  assert.deepEqual(b.calibration.easy, ['gaming', 'music']);
  assert.equal(b.calibration.lengthMin, 20);
  assert.deepEqual(b.moodProfiles.drained.avoid, ['news'], 'a type cannot be liked and avoided');
  assert.deepEqual(b.moodProfiles.drained.likeWords, ['stardew', 'lofi']);
  assert.equal(b.moodProfiles.drained.maxMinutes, 20);
  assert.ok(b.moodProfiles.drained.like.includes('vlogs'), 'creators comfort you → vlogs allowed when drained');
  assert.equal(b.overrides.drained.emotional, 'show', 'mood matching → emotional content allowed in low moods');
  assert.equal(b.overrides.drained.blockParasocial, false);
  assert.equal(b.overrides.curious.politics, 'hide', 'news leaves you tense');
  assert.equal((b.overrides.focused || {}).politics, undefined, 'focused keeps its own choice');
});

test('personalize: your "easy" and "demanding" beat the defaults; strain factors add effort', () => {
  const cal = Pr.build(answers).calibration;
  const essay = C.classify({ title: 'A short video essay on bread', durationText: '9:00' });
  assert.equal(Pr.personalize(essay, { title: 'x' }, cal, C.titleComplexity).load, 2);
  const longGame = C.classify({ title: 'Minecraft let\'s play', durationText: '1:30:00' });
  assert.equal(longGame.load, 1, 'over an hour → medium by default');
  const pg = Pr.personalize(longGame, { title: 'x' }, cal, C.titleComplexity);
  assert.ok(pg.load >= 1, 'gaming is easy for you, but 90 minutes is long for you');
  const shortGame = Pr.personalize(C.classify({ title: 'Minecraft let\'s play', durationText: '15:00' }), { title: 'x' }, cal, C.titleComplexity);
  assert.equal(shortGame.load, 0);
  const sad = Pr.personalize(C.classify({ title: 'My story of grief', durationText: '8:00' }), { title: 'x' }, cal, C.titleComplexity);
  assert.equal(sad.load, 2, 'emotional topics tire you');
  assert.equal(Pr.personalize(essay, {}, null).load, essay.load, 'no questionnaire → unchanged');
});

test('moodProfileFor: answers → custom mood profile → defaults', () => {
  const b = Pr.build(answers);
  assert.equal(Pr.moodProfileFor(b, 'drained').maxMinutes, 20);
  assert.ok(Pr.moodProfileFor(null, 'drained').like.includes('ambient'));
  assert.deepEqual(Pr.moodProfileFor(b, 'mood_x', { profile: { like: ['music'] } }).like, ['music']);
  assert.equal(Pr.moodProfileFor(null, 'need:relax'), null);
});
