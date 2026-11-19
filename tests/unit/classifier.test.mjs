import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../core/classifier.js';

const C = globalThis.MindfulClassifier;
const cls = (title, extra = {}) => C.classify({ title, ...extra });

test('relaxing ambience is relax, load 0, light', () => {
  const p = cls('3 Hours of Gentle Rain Sounds for Sleep', { durationText: '3:00:00' });
  assert.ok(p.needs.includes('relax'));
  assert.equal(p.load, 0);
  assert.equal(p.tone, 'light');
  assert.equal(p.political, false);
});

test('political rage bait is political, heavy and addictive', () => {
  const p = cls('Senator DESTROYS woke reporter in INSANE exchange!!!');
  assert.equal(p.political, true);
  assert.equal(p.tone, 'heavy');
  assert.ok(p.addictive >= 3, 'addictive score ' + p.addictive);
});

test('parasocial vlog content is detected', () => {
  assert.ok(cls('We need to talk… (life update)').parasocial >= 2);
  assert.ok(cls('A day in my life as a 25 year old | vlog').parasocial >= 2);
  assert.ok(cls('Responding to the drama').parasocial >= 2);
});

test('long lecture is informational and strenuous', () => {
  const p = cls('Lecture 1: Introduction to Linear Algebra', { durationText: '1:12:40' });
  assert.equal(p.informational, true);
  assert.equal(p.load, 2);
  assert.ok(p.needs.includes('learn'));
});

test('short explainer is light curiosity', () => {
  const p = cls('Why do cats purr? Explained', { durationText: '6:12' });
  assert.equal(p.informational, true);
  assert.equal(p.load, 1);
  assert.ok(p.needs.includes('curious'));
  assert.ok(p.topics.includes('pets'));
});

test('comedy is laugh and light', () => {
  const p = cls('Funny sketch: when your cat judges your cooking');
  assert.ok(p.needs.includes('laugh'));
  assert.equal(p.tone, 'light');
});

test('true crime is distressing', () => {
  const p = cls('The unsolved murder that shocked a small town | True Crime');
  assert.equal(p.distressing, true);
  assert.equal(p.tone, 'heavy');
});

test('shorts get a high addictive score', () => {
  assert.ok(cls('cute dog', { isShort: true }).addictive >= 5);
});

test('word boundaries: "crash course" is not distressing, "total" is not "tot"', () => {
  assert.equal(cls('Crash Course Biology #1').distressing, false);
  assert.equal(cls('Total beginner guide to watercolor').distressing, false);
});

test('German keywords work', () => {
  assert.equal(cls('Bundestag: Kanzler Merz zur Wahl').political, true);
  assert.ok(cls('Entspannende Musik zum Einschlafen').needs.includes('relax'));
});

test('recipes are "create"', () => {
  const p = cls('Easy sourdough bread recipe for beginners');
  assert.ok(p.needs.includes('create'));
  assert.ok(p.topics.includes('food'));
});

test('mergeAi overrides heuristic fields', () => {
  const base = cls('Something ambiguous');
  const m = C.mergeAi(base, { needs: ['laugh'], load: 0, tone: 'light', political: false, parasocial: true, addictive: false, informational: false, topics: ['comedy'], reason: 'sketch show' });
  assert.deepEqual(m.needs, ['laugh']);
  assert.ok(m.parasocial >= 2);
  assert.equal(m.source, 'ai');
  assert.equal(m.known, true);
});

test('parseDuration', () => {
  assert.equal(C.parseDuration('1:02:03'), 3723);
  assert.equal(C.parseDuration('4:05'), 245);
  assert.equal(C.parseDuration('LIVE'), null);
});
