// End-to-end test: runs the real bundle in Chromium against a fake
// m.youtube.com that behaves like the real one (embedded ytInitialData,
// fetch-based feed continuation, XHR-based watch-next continuation).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bundle } from '../../scripts/build.mjs';
import { homeBrowse, watchNext, playerResponse, vwc, post } from '../fixtures.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const RENDER = `
<script>
  function txt(x){ if(!x) return ''; if(typeof x==='string') return x; if(x.simpleText) return x.simpleText; if(x.runs) return x.runs.map(r=>r.text).join(''); if(x.content) return x.content; return ''; }
  function card(tag, id, title){ const el=document.createElement(tag); const a=document.createElement('a'); a.href='/watch?v='+id; const h=document.createElement('h3'); h.textContent=title; a.appendChild(h); el.appendChild(a); return el; }
  function renderItems(list, root){
    for (const it of list) {
      const o = it.richItemRenderer ? it.richItemRenderer.content : it;
      if (o.videoRenderer) root.appendChild(card('ytm-rich-item-renderer', o.videoRenderer.videoId, txt(o.videoRenderer.title)));
      else if (o.lockupViewModel) root.appendChild(card('ytm-rich-item-renderer', o.lockupViewModel.contentId, o.lockupViewModel.metadata.lockupMetadataViewModel.title.content));
      else if (o.videoWithContextRenderer) root.appendChild(card(it.richItemRenderer ? 'ytm-rich-item-renderer' : 'ytm-video-with-context-renderer', o.videoWithContextRenderer.videoId, txt(o.videoWithContextRenderer.headline)));
      else if (o.adSlotRenderer) root.appendChild(card('ytm-rich-item-renderer', 'AD_________', 'AD'));
      else if (o.backstagePostThreadRenderer) { const el = document.createElement('ytm-backstage-post-thread-renderer'); el.textContent = 'POST'; root.appendChild(el); }
      else if (it.richSectionRenderer && it.richSectionRenderer.content.richShelfRenderer && !it.richSectionRenderer.content.richShelfRenderer.isShorts) renderItems(it.richSectionRenderer.content.richShelfRenderer.contents, root);
      else if (it.richSectionRenderer) root.appendChild(card('ytm-reel-shelf-renderer', 'short000001', 'SHORTS SHELF'));
      else if (it.itemSectionRenderer) renderItems(it.itemSectionRenderer.contents, root);
      else if (it.reelShelfRenderer) root.appendChild(card('ytm-reel-shelf-renderer', 'short000009', 'SHORTS SHELF'));
    }
  }
</script>`;

function homeHtml() {
  return `<!doctype html><html><head><title>YouTube</title></head><body>
  ${RENDER}
  <script>var ytInitialData = ${JSON.stringify(homeBrowse())};</script>
  <ytm-feed-filter-chip-bar-renderer><ytm-chip-cloud-chip-renderer id="chip-all">All</ytm-chip-cloud-chip-renderer><ytm-chip-cloud-chip-renderer id="chip-posts"><span>Posts</span></ytm-chip-cloud-chip-renderer></ytm-feed-filter-chip-bar-renderer>
  <div id="feed"></div>
  <script>
    document.getElementById('chip-posts').addEventListener('click', async () => {
      const r = await fetch('/youtubei/v1/browse', { method: 'POST', body: JSON.stringify({ continuation: 'CHIP_POSTS' }) });
      const j = await r.json(); const f = document.getElementById('feed'); f.textContent = '';
      renderItems(j.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems, f);
      window.chipLoaded = true;
    });
    const d = window.ytInitialData;
    renderItems(d.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents, document.getElementById('feed'));
    let busy = false;
    window.addEventListener('scroll', async () => {
      if (busy || window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 50) return;
      busy = true; try { await window.loadMore(); } finally { busy = false; }
    });
    window.loadMore = async () => {
      const r = await fetch('/youtubei/v1/browse?prettyPrint=false', { method: 'POST', body: JSON.stringify({ continuation: 'NEXT' }) });
      const j = await r.json();
      renderItems(j.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems, document.getElementById('feed'));
      return true;
    };
  </script></body></html>`;
}

function watchHtml(id) {
  return `<!doctype html><html><head><title>The video you chose - YouTube</title></head><body>
  ${RENDER}
  <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse(id))};</script>
  <script>var ytInitialData = ${JSON.stringify(watchNext(id))};</script>
  <div id="related"></div>
  <script>
    const r = window.ytInitialData.contents.singleColumnWatchNextResults.results.results.contents;
    renderItems(r, document.getElementById('related'));
    window.playerHasEndscreen = !!window.ytInitialPlayerResponse.endscreen;
    window.loadMoreXhr = () => new Promise(res => {
      const x = new XMLHttpRequest(); x.open('POST', '/youtubei/v1/next'); x.responseType = 'json';
      x.onload = () => { renderItems(x.response.onResponseReceivedEndpoints[0].appendContinuationItemsAction.continuationItems, document.getElementById('related')); res(true); };
      x.send(JSON.stringify({ continuation: 'MORE_RELATED' }));
    });
  </script></body></html>`;
}

const continuation = {
  onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
    { richItemRenderer: { content: vwc('more_relax1', 'Relaxing ocean waves at sunset', 'Calm Place', '1:00:00') } },
    { richItemRenderer: { content: vwc('more_drama', 'Drama exposed: storytime reaction', 'Tea Spiller', '19:00') } },
    { continuationItemRenderer: {} },
  ] } }],
};
const generatedBatch = n => ({
  onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
    { richItemRenderer: { content: vwc('gen' + n + 'a_____', 'Relaxing piano for a calm evening ' + n, 'Calm Place', '30:00') } },
    { richItemRenderer: { content: vwc('gen' + n + 'b_____', 'Minecraft castle build ' + n, 'Blocky', '12:00') } },
    { continuationItemRenderer: {} },
  ] } }],
});
const postsChipResponse = {
  onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
    { richItemRenderer: { content: post('chip_post1', 'A post you asked for') } },
    { richItemRenderer: { content: post('chip_post2', 'Another post') } },
  ] } }],
};
const nextContinuation = {
  onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
    vwc('rel_more001', 'Another related video', 'X', '9:00'),
  ] } }],
};

let browser;
before(async () => { if (chromium) browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

async function newPage(pre) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
  if (pre) await ctx.addInitScript(pre); // runs before the app reads its storage
  await ctx.addInitScript({ content: bundle() });
  let batch = 0;
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'm.youtube.com') return route.abort();
    if (url.pathname === '/youtubei/v1/browse') {
      const body = route.request().postData() || '';
      if (body.includes('CHIP_POSTS')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(postsChipResponse) });
      batch++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(batch === 1 ? continuation : generatedBatch(batch)) });
    }
    if (url.pathname === '/youtubei/v1/next') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(nextContinuation) });
    if (url.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: watchHtml(url.searchParams.get('v')) });
    return route.fulfill({ contentType: 'text/html', body: homeHtml() });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return { page, ctx, errors };
}

async function renderedIds(page) {
  return page.$$eval('#feed > *, #related > *', els => els.filter(e => getComputedStyle(e).display !== 'none').map(e => (e.querySelector('a').getAttribute('href').split('v=')[1])));
}

test('home feed is filtered before rendering; continuation via fetch is filtered too', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  await page.goto('https://m.youtube.com/');
  let ids = await renderedIds(page);
  // Default settings: apolitical, no parasocial, no distressing, capacity "in-between".
  assert.ok(ids.includes('vid_relax01'), ids.join());
  assert.ok(ids.includes('vid_info001'));
  assert.ok(ids.includes('vid_laugh01'));
  for (const gone of ['vid_polit01', 'vid_para001', 'vid_crime01', 'vid_lect001', 'short000001']) assert.ok(!ids.includes(gone), gone + ' should be filtered');

  await page.evaluate(() => window.loadMore());
  ids = await renderedIds(page);
  assert.ok(ids.includes('more_relax1'));
  assert.ok(!ids.includes('more_drama'));

  // The demanding lecture was caught on the Later shelf instead of being lost.
  const shelf = await page.evaluate(() => window.MindfulFeed.shelf().map(x => x.id));
  assert.ok(shelf.includes('vid_lect001'), 'lecture should be on the shelf: ' + shelf.join());
  assert.equal(await page.locator('#feed ytm-backstage-post-thread-renderer').count(), 0, 'community posts removed from the home feed');
  assert.match(await page.locator('#mindful-feed-ui .stat').innerText(), /\d+ shown · \d+ held back/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('community posts appear only when the "Posts" chip is selected', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  await page.addInitScript(() => localStorage.setItem('mindful:lastCheckIn', String(Date.now())));
  await page.goto('https://m.youtube.com/');
  assert.equal(await page.locator('#feed ytm-backstage-post-thread-renderer').count(), 0);
  await page.locator('#chip-posts').click();
  await page.waitForFunction(() => window.chipLoaded);
  const posts = page.locator('#feed ytm-backstage-post-thread-renderer');
  assert.equal(await posts.count(), 2);
  assert.equal(await posts.first().isVisible(), true, 'not hidden by CSS either');
  // back to "All" → posts are hidden again
  await page.locator('#chip-all').click();
  assert.equal(await posts.first().isVisible(), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('check-in appears and a preset re-filters the feed', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  await page.goto('https://m.youtube.com/');
  const sheet = page.locator('#mindful-feed-ui').locator('.sheet');
  await sheet.waitFor({ timeout: 5000 });
  assert.match(await sheet.innerText(), /How are you right now/);
  await Promise.all([
    page.waitForNavigation(),
    page.locator('#mindful-feed-ui').getByRole('button', { name: /Drained/ }).click(),
  ]);
  const ids = await renderedIds(page);
  assert.ok(ids.includes('vid_relax01'));
  assert.ok(ids.includes('vid_garden1'));
  assert.ok(!ids.includes('vid_info001'), 'informational is not for a drained state');
  assert.ok(ids.includes('vid_laugh01'), 'light comedy helps when drained (default mood profile)');
  assert.ok(!ids.includes('vid_lect001') && !ids.includes('vid_crime01'));
  const shelf = await page.evaluate(() => window.MindfulFeed.shelf().map(x => x.id));
  assert.ok(shelf.includes('vid_info001'));
  assert.equal(await page.locator('#mindful-feed-ui').locator('.sheet').count(), 0, 'check-in should not reappear');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('watch page: no recommendations, no end screen, playlist kept, info budget counted', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  await page.goto('https://m.youtube.com/watch?v=current0001');
  let ids = await renderedIds(page);
  assert.deepEqual(ids, [], 'no related videos rendered: ' + ids.join());
  assert.equal(await page.evaluate(() => window.playerHasEndscreen), false);
  await page.evaluate(() => window.loadMoreXhr());
  ids = await renderedIds(page);
  assert.deepEqual(ids, [], 'XHR continuation filtered too');
  // "+ Later shelf" chip shows on watch pages
  const chip = page.locator('#mindful-feed-ui').locator('.chip:not(.rate)');
  assert.equal(await page.locator('#mindful-feed-ui').locator('.chip.rate').isVisible(), true, '"Fits my mode?" chip on watch pages');
  await chip.waitFor();
  await chip.click();
  assert.match(await chip.innerText(), /On your shelf/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('DOM safety net filters cards that never went through the JSON layer', { skip: !chromium && 'playwright not installed' }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
  await ctx.addInitScript({ content: bundle() });
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'm.youtube.com') return route.abort();
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${RENDER}<div id="feed"></div>
      <script>
        setTimeout(() => {
          const f = document.getElementById('feed');
          f.appendChild(card('ytm-rich-item-renderer', 'dom_relax01', 'Calming forest ambience for focus'));
          f.appendChild(card('ytm-rich-item-renderer', 'dom_polit01', 'Election night: president slams the opposition'));
          f.appendChild(card('ytm-rich-item-renderer', 'dom_vlog001', 'Storytime: we broke up (vlog)'));
        }, 300);
      </script></body></html>` });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('mindful:lastCheckIn', String(Date.now())));
  await page.goto('https://m.youtube.com/');
  await page.waitForFunction(() => document.querySelectorAll('#feed > *').length === 3);
  await page.waitForFunction(() => document.querySelectorAll('#feed > .mf-hidden').length === 2, null, { timeout: 3000 });
  const ids = await renderedIds(page);
  assert.deepEqual(ids, ['dom_relax01']);
  // labels are added to visible cards
  assert.match(await page.locator('#feed .mf-badge').first().innerText(), /easy/);
  await ctx.close();
});

test('check-in: Focused asks political / apolitical / both', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  await page.goto('https://m.youtube.com/');
  const ui = page.locator('#mindful-feed-ui');
  await ui.locator('.sheet').waitFor();
  await ui.getByRole('button', { name: /Focused/ }).click();
  assert.match(await ui.locator('.sheet').innerText(), /Which topics are you up for/);
  await Promise.all([page.waitForNavigation(), ui.getByRole('button', { name: /Only political/ }).click()]);
  const s = await page.evaluate(() => window.MindfulFeed.settings());
  assert.equal(s.need, 'learn');
  assert.equal(s.politics, 'only');
  assert.deepEqual(s.loads, [1, 2]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('feedback sheet: "doesn\'t fit" hides the card at once and is remembered after reload', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  await page.addInitScript(() => localStorage.setItem('mindful:lastCheckIn', String(Date.now())));
  await page.goto('https://m.youtube.com/');
  const badge = page.locator('#feed a[href$="vid_garden1"]').locator('xpath=..').locator('.mf-badge');
  await badge.waitFor();
  await badge.click();
  const ui = page.locator('#mindful-feed-ui');
  assert.match(await ui.locator('.sheet').innerText(), /Does this fit right now/);
  await ui.getByRole('button', { name: /Doesn't fit/ }).click();
  await ui.getByRole('button', { name: /Too heavy/ }).click();
  await ui.getByRole('button', { name: /^Save$/ }).click();
  assert.match(await ui.locator('.sheet').innerText(), /Got it/);
  await page.waitForFunction(() => !document.querySelector('#feed a[href$="vid_garden1"]').closest('ytm-rich-item-renderer').offsetParent);
  await ui.getByRole('button', { name: /^Done$/ }).click();
  await page.reload();
  const ids = await renderedIds(page);
  assert.ok(!ids.includes('vid_garden1'), 'still filtered after reload');
  await page.waitForFunction(() => localStorage.getItem('mindful:log'));
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem('mindful:log')).map(x => x.reason));
  assert.ok(log.some(r => /you said this doesn't fit/.test(r)), log.join(' | '));
  assert.deepEqual(errors, []);
  await ctx.close();
});

async function openTeach(page) {
  await page.addInitScript(() => localStorage.setItem('mindful:lastCheckIn', String(Date.now())));
  await page.goto('https://m.youtube.com/');
  const ui = page.locator('#mindful-feed-ui');
  await ui.locator('.fab').click();
  await ui.getByRole('button', { name: /Teach/ }).click();
  return ui;
}
const learnerState = page => page.evaluate(() => JSON.parse(localStorage.getItem('mindful:learner') || '{}'));

test('Teach › quick check: yes/no for the current mood', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  const ui = await openTeach(page);
  await ui.getByRole('button', { name: /Quick check/ }).click();
  assert.match(await ui.locator('.progress').innerText(), /^1 \/ \d+/);
  await ui.getByRole('button', { name: /^✅ Fits$/ }).click();
  assert.match(await ui.locator('.progress').innerText(), /^2 \//);
  await ui.getByRole('button', { name: /Doesn't fit/ }).click();
  await ui.getByRole('button', { name: /Political/ }).click();
  await ui.getByRole('button', { name: /^Next$/ }).click();
  assert.match(await ui.locator('.progress').innerText(), /^3 \//);
  assert.equal((await learnerState(page)).count, 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Teach › sort my feed: several moods, "fits no mood", "never show" with confirmation', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  const ui = await openTeach(page);
  await ui.getByRole('button', { name: /Sort my feed/ }).click();
  const title = async () => (await ui.locator('.card .t').first().innerText()).trim();
  const idOf = t => page.evaluate(t => [...window.MindfulFeed.verdicts.values()].find(v => v.meta.title === t).meta.id, t);

  assert.equal(await ui.getByRole('button', { name: /Save & next/ }).isDisabled(), true, 'needs at least one mood');
  const first = await idOf(await title());
  await ui.getByRole('button', { name: /Drained/ }).click();
  await ui.getByRole('button', { name: /Need a laugh/ }).click();
  await ui.getByRole('button', { name: /Save & next/ }).click();
  let L = await learnerState(page);
  assert.equal(L.videos[first].drained, 1);
  assert.equal(L.videos[first].laugh, 1);
  assert.equal(L.videos[first].sleep, -1, 'unselected moods: does not fit');

  const second = await idOf(await title());
  await ui.getByRole('button', { name: /^Fits no mood$/ }).click();
  L = await learnerState(page);
  assert.ok(L.videos[second].nomood, 'in the "fits no mood" pile');

  const third = await idOf(await title());
  await ui.getByRole('button', { name: /Never show this/ }).click();
  assert.match(await ui.locator('.sheet').innerText(), /Are you sure/);
  await ui.getByRole('button', { name: /Yes, never show it/ }).click();
  L = await learnerState(page);
  assert.equal(L.videos[third].never, true);
  assert.match(await ui.locator('.progress').innerText(), /^3 sorted/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Create a mood from the "fits no mood" pile and use it', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  const ui = await openTeach(page);
  await ui.getByRole('button', { name: /Sort my feed/ }).click();
  const t = (await ui.locator('.card .t').first().innerText()).trim();
  const vid = await page.evaluate(t => [...window.MindfulFeed.verdicts.values()].find(v => v.meta.title === t).meta.id, t);
  await ui.getByRole('button', { name: /^Fits no mood$/ }).click();
  await ui.getByRole('button', { name: /Back/ }).click();
  await ui.getByRole('button', { name: /Create a mood/ }).click();
  await ui.locator('input[placeholder^="Name"]').fill('Cozy corner');
  await ui.locator('label.card', { hasText: t }).locator('input[type=checkbox]').check();
  await ui.getByRole('button', { name: /Create & use this mood/ }).click();
  const s = await page.evaluate(() => window.MindfulFeed.settings());
  assert.equal(s.need, 'custom');
  assert.match(await ui.locator('.sheet').innerText(), /✨ Cozy corner/);
  await Promise.all([page.waitForNavigation(), ui.locator('.x').first().click()]);
  const ids = await renderedIds(page);
  assert.ok(ids.includes(vid), 'the added video is in the new mood: ' + ids.join());
  assert.ok(!ids.includes('vid_lect001'));
  // the new mood is offered in the check-in grid as well
  assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem('mindful:moods')).map(m => m.label))).includes('Cozy corner'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Load more fetches further recommendations from YouTube; a near-empty feed fills itself', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage(() => {
    localStorage.setItem('mindful:lastCheckIn', String(Date.now()));
    localStorage.setItem('mindful:settings', JSON.stringify({ need: 'inspire', loads: [0, 1], tone: 'light', strictNeed: true }));
  });
  await page.goto('https://m.youtube.com/');
  const start = await page.evaluate(() => window.MindfulFeed.verdicts.size);
  // auto-fill: nothing fits "need a lift" here, so it keeps asking YouTube for more
  await page.waitForFunction(n => window.MindfulFeed.verdicts.size > n + 2, start, { timeout: 15000 });
  const ui = page.locator('#mindful-feed-ui');
  await ui.locator('.fab').click();
  await ui.getByRole('button', { name: /Teach/ }).click();
  await ui.getByRole('button', { name: /Sort my feed/ }).click();
  const before = await page.evaluate(() => window.MindfulFeed.verdicts.size);
  await ui.getByRole('button', { name: /Load more videos/ }).click();
  await ui.getByText(/new videos from YouTube/).waitFor({ timeout: 15000 });
  const after = await page.evaluate(() => window.MindfulFeed.verdicts.size);
  assert.ok(after > before, before + ' → ' + after);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('setup questionnaire: answers shape what each mood shows', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, ctx, errors } = await newPage();
  await page.goto('https://m.youtube.com/');
  const ui = page.locator('#mindful-feed-ui');
  await ui.getByRole('button', { name: /Start setup/ }).click();
  const q = () => ui.locator('.big').first().innerText();
  const next = () => ui.getByRole('button', { name: /^(Next|Skip) ›$/ }).click();
  assert.match(await q(), /worn out/);
  await ui.getByRole('button', { name: /Gaming/ }).click(); await next();          // easy
  await ui.getByRole('button', { name: /Video essays/ }).click(); await next();    // demanding
  await ui.getByRole('button', { name: /Emotional topics/ }).click(); await next(); // what tires you
  await ui.getByRole('button', { name: /About 20 minutes/ }).click();              // length (auto-advances)
  assert.match(await q(), /feeling low/);
  await ui.getByRole('button', { name: /meets me where I am/ }).click();
  await ui.getByRole('button', { name: /Tense, worried/ }).click();
  await next();                                                                      // creators: skip
  assert.match(await q(), /Which moods/);
  for (const name of [/Anxious/, /Just unwinding/, /Need a laugh/, /Curious/, /Focused/, /Winding down/]) await ui.getByRole('button', { name }).click();
  await next();
  assert.match(await q(), /drained, what actually helps/);
  await ui.getByRole('button', { name: /Gaming/ }).click(); await next();
  await next();                                                                      // avoid: keep defaults
  await ui.getByRole('button', { name: /Up to 20 minutes/ }).click();
  await ui.locator('input[placeholder^="e.g. lofi"]').fill('stardew, bob ross');
  await next();
  assert.match(await ui.locator('.sheet').innerText(), /Here's what Mindful Feed will do/);
  await ui.getByRole('button', { name: /Save & apply/ }).click();
  const p = await page.evaluate(() => JSON.parse(localStorage.getItem('mindful:profile')));
  assert.deepEqual(p.calibration.easy, ['gaming']);
  assert.deepEqual(p.calibration.hard, ['essays']);
  assert.equal(p.calibration.lengthMin, 20);
  assert.ok(p.moodProfiles.drained.like.includes('gaming'));
  assert.equal(p.moodProfiles.drained.maxMinutes, 20);
  assert.deepEqual(p.moodProfiles.drained.likeWords, ['stardew', 'bob ross']);
  assert.equal(p.overrides.drained.emotional, 'show');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('unclear videos are kept hidden while YouTube\'s category is looked up, then decided', { skip: !chromium && 'playwright not installed' }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('mindful:lastCheckIn', String(Date.now()));
    localStorage.setItem('mindful:preset', JSON.stringify('drained'));
    localStorage.setItem('mindful:settings', JSON.stringify({ need: 'relax', loads: [0], tone: 'light', strictNeed: true, music: 'show', emotional: 'hide' }));
  });
  await ctx.addInitScript({ content: bundle() });
  const data = { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [
    { richItemRenderer: { content: vwc('aurora00001', 'Aurora borealis over Lofoten', 'Northern Sky', '58:00') } },
    { richItemRenderer: { content: vwc('lecture0001', 'Northern lights tonight', 'Sky Uni', '48:00') } },
  ] } } } }] } } };
  const lookups = [];
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'm.youtube.com') return route.abort();
    if (url.pathname === '/youtubei/v1/player') {
      const body = JSON.parse(route.request().postData());
      lookups.push(body.videoId);
      const cat = body.videoId === 'aurora00001' ? { category: 'Music', kw: ['ambient', 'relaxing music', 'sleep'] } : { category: 'Education', kw: ['physics', 'lecture'] };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ videoDetails: { videoId: body.videoId, keywords: cat.kw, shortDescription: 'x' }, microformat: { playerMicroformatRenderer: { category: cat.category } } }) });
    }
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${RENDER}<script>window.ytcfg = { get: k => ({ INNERTUBE_CONTEXT: { client: { clientName: 'MWEB', clientVersion: '2.0' } } })[k] };</script>
      <script>var ytInitialData = ${JSON.stringify(data)};</script><div id="feed"></div>
      <script>renderItems(ytInitialData.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents, document.getElementById('feed'));</script></body></html>` });
  });
  const page = await ctx.newPage();
  await page.goto('https://m.youtube.com/');
  await page.waitForFunction(() => { const e = JSON.parse(localStorage.getItem('mindful:enrich') || '{}'); return e.aurora00001 && e.lecture0001; }, null, { timeout: 10000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#feed a[href$="aurora00001"]').closest('ytm-rich-item-renderer')).display !== 'none', null, { timeout: 5000 });
  const ids = await renderedIds(page);
  assert.deepEqual(ids, ['aurora00001'], 'ambient music fits "drained", the educational one does not');
  assert.deepEqual(lookups.sort(), ['aurora00001', 'lecture0001']);
  await ctx.close();
});
