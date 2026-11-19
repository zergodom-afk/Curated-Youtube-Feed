import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../core/extractor.js';
import { homeBrowse, watchNext, playerResponse, HOME_ITEMS } from '../fixtures.mjs';

const X = globalThis.MindfulExtractor;

function ids(json) {
  const out = [];
  JSON.stringify(json, (k, v) => { if ((k === 'videoId' || k === 'contentId') && typeof v === 'string') out.push(v); return v; });
  return out;
}

test('extracts metadata from all renderer shapes', () => {
  const seen = [];
  X.prune(homeBrowse(), { decide: m => { seen.push(m); return { remove: false }; }, hideShorts: false, hideAds: false });
  for (const [id, title, channel, len] of HOME_ITEMS) {
    const m = seen.find(x => x.id === id);
    assert.ok(m, 'missing ' + id);
    assert.equal(m.title, title);
    assert.equal(m.channel, channel);
    assert.equal(m.durationText, len);
    assert.equal(m.isShort, false);
  }
  assert.ok(seen.some(m => m.id === 'short000001' && m.isShort));
});

test('prunes items by verdict, removes Shorts shelves and ads, keeps continuation', () => {
  const data = homeBrowse();
  const stats = X.prune(data, { decide: m => ({ remove: m.id === 'vid_polit01' }), hideShorts: true, hideAds: true });
  const left = ids(data);
  assert.ok(!left.includes('vid_polit01'));
  assert.ok(left.includes('vid_relax01'));
  assert.ok(!left.includes('short000001'));
  assert.ok(!JSON.stringify(data).includes('short000002'));
  assert.ok(!JSON.stringify(data).includes('adSlotRenderer'));
  assert.ok(JSON.stringify(data).includes('"NEXT"'), 'feed continuation must survive');
  assert.ok(stats.removed >= 2);
});

test('community posts: removed with hidePosts (single items and "Latest posts" shelves), kept otherwise', () => {
  const kept = homeBrowse();
  X.prune(kept, { hidePosts: false });
  for (const id of ['post_one', 'post_two', 'post_three']) assert.ok(JSON.stringify(kept).includes(id));
  const data = homeBrowse();
  const stats = X.prune(data, { hidePosts: true });
  const s = JSON.stringify(data);
  for (const id of ['post_one', 'post_two', 'post_three']) assert.ok(!s.includes(id), id);
  assert.ok(s.includes('vid_relax01') && s.includes('"NEXT"'));
  assert.equal(stats.postsRemoved, 2);
  assert.equal(X.isPostElement({ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_POST' } }), true);
  assert.equal(X.isPostElement({ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } }), false);
});

test('watch page: removes all recommendations, keeps playlist, comments and current video', () => {
  const data = watchNext('current0001');
  X.pruneAutoplay(data);
  X.prune(data, { watchPage: true, currentVideoId: 'current0001' });
  const s = JSON.stringify(data);
  assert.ok(!s.includes('rel_000001') && !s.includes('rel_000002'));
  assert.ok(!s.includes('MORE_RELATED'), 'related continuation removed');
  assert.ok(!s.includes('reelShelfRenderer'));
  assert.ok(s.includes('COMMENTS'), 'comments continuation kept');
  assert.ok(s.includes('pl_item_001'), 'playlist kept');
  assert.ok(!data.contents.singleColumnWatchNextResults.autoplay);
  assert.ok(!data.playerOverlays.playerOverlayRenderer.endScreen);
});

test('player: end screens and cards removed, ads untouched', () => {
  const p = X.prunePlayer(playerResponse('abc'), {});
  assert.equal(p.endscreen, undefined);
  assert.equal(p.cards, undefined);
  assert.ok(Array.isArray(p.adPlacements));
  assert.equal(p.videoDetails.videoId, 'abc');
});
