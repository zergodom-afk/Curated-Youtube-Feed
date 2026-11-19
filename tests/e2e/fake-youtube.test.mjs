// End-to-end test: runs the real bundle in Chromium against a fake
// m.youtube.com that behaves like the real one (embedded ytInitialData,
// fetch-based feed continuation, XHR-based watch-next continuation).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bundle } from '../../scripts/build.mjs';
import { homeBrowse, watchNext, playerResponse, vwc } from '../fixtures.mjs';

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
  <div id="feed"></div>
  <script>
    const d = window.ytInitialData;
    renderItems(d.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents, document.getElementById('feed'));
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
const nextContinuation = {
  onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
    vwc('rel_more001', 'Another related video', 'X', '9:00'),
  ] } }],
};

let browser;
before(async () => { if (chromium) browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
  await ctx.addInitScript({ content: bundle() });
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'm.youtube.com') return route.abort();
    if (url.pathname === '/youtubei/v1/browse') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(continuation) });
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
  assert.ok(!ids.includes('vid_laugh01'), 'drained = relax need only');
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
  const chip = page.locator('#mindful-feed-ui').locator('.chip');
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
