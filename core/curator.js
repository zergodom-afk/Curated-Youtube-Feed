/*
 * Mindful Feed – in-page runtime for m.youtube.com / www.youtube.com.
 *
 * Injected at document start (Android WebView via addDocumentStartJavaScript,
 * or as a userscript). Requires classifier.js, extractor.js and policy.js to
 * have run first (the build concatenates them).
 *
 *  1. Intercepts YouTube's own JSON (ytInitialData + /youtubei/v1/*) and
 *     prunes videos that don't fit your current state, *before* rendering.
 *  2. A DOM safety net hides anything that slipped through, removes the
 *     recommendation rails on the watch page and the Shorts tab.
 *  3. Mood check-in, Later shelf, filter log and settings live in a small
 *     panel (shadow DOM) behind the 🧭 button.
 *  4. Optional AI classification through the Android host (MindfulNative).
 *
 * Never uses innerHTML (YouTube enforces Trusted Types).
 */
(function () {
  'use strict';
  if (window.__mindfulFeed) return;
  if (window.top !== window) return;
  window.__mindfulFeed = true;

  const C = window.MindfulClassifier;
  const X = window.MindfulExtractor;
  const P = window.MindfulPolicy;
  if (!C || !X || !P) { console.warn('[MindfulFeed] core modules missing'); return; }

  // ---------------------------------------------------------------------------
  // Storage (localStorage on the YouTube origin; survives app restarts)
  // ---------------------------------------------------------------------------
  const NS = 'mindful:';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* quota / disabled */ } },
  };

  let S = P.merge(store.get('settings', null));
  function saveSettings() { store.set('settings', S); }

  let shelf = store.get('shelf', []);
  let shelfStats = store.get('shelfStats', { letGo: 0, watched: 0, since: Date.now() });
  let letGoIds = store.get('letGoIds', {}); // id -> timestamp, so auto-catch doesn't re-add right away
  let infoState = store.get('info', { day: '', count: 0, ids: [], lastActive: 0 });
  let filterLog = store.get('log', []);
  let aiCache = store.get('aiCache', {});
  let lastCheckIn = store.get('lastCheckIn', 0);
  let currentPreset = store.get('preset', null);

  const verdicts = new Map(); // id -> {meta, prof, d}
  const profiles = new Map();

  // Mutable runtime state (declared up front: hooks may fire early).
  let native = null, aiQueue = [], aiInFlight = 0, aiStatus = 'unavailable', aiReqSeq = 1;
  const aiPending = new Map();
  let host = null, shadow = null, wrapEl = null, fabEl = null, chipEl = null;
  let panelOpen = false, activeTab = 'now', checkInOpen = false;
  let styleEl = null, scanQueued = false, dirty = false;
  let lastHref = location.href, lastWatched = null;

  function todayKey() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function refreshInfoWindow() {
    const now = Date.now();
    if (S.infoBudgetWindow === 'session') {
      if (now - (infoState.lastActive || 0) > 3 * 3600 * 1000) infoState = { day: todayKey(), count: 0, ids: [], lastActive: now };
    } else if (infoState.day !== todayKey()) {
      infoState = { day: todayKey(), count: 0, ids: [], lastActive: now };
    }
    infoState.lastActive = now;
  }
  function infoUsed() { refreshInfoWindow(); return infoState.count; }

  function persistSoon() {
    clearTimeout(persistSoon.t);
    persistSoon.t = setTimeout(() => {
      store.set('shelf', shelf); store.set('shelfStats', shelfStats); store.set('letGoIds', letGoIds);
      store.set('info', infoState); store.set('log', filterLog.slice(-150));
      const keys = Object.keys(aiCache);
      if (keys.length > 2500) { for (const k of keys.slice(0, keys.length - 2000)) delete aiCache[k]; }
      store.set('aiCache', aiCache);
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------
  function pageContext(pathname) {
    const p = pathname || location.pathname;
    if (p === '/' || p.startsWith('/feed/what_to_watch') || p === '/index') return 'home';
    if (p.startsWith('/feed/subscriptions')) return 'subscriptions';
    if (p.startsWith('/feed/history') || p.startsWith('/feed/library') || p.startsWith('/feed/you') || p.startsWith('/playlist')) return 'playlist';
    if (p.startsWith('/results')) return 'search';
    if (p.startsWith('/watch')) return 'watch';
    if (p.startsWith('/shorts')) return 'shorts';
    if (/^\/(@|channel\/|c\/|user\/)/.test(p)) return 'channel';
    return 'other';
  }
  function contextFromBrowseId(id) {
    if (!id) return null;
    if (id === 'FEwhat_to_watch') return 'home';
    if (id === 'FEsubscriptions') return 'subscriptions';
    if (/^FE(history|library|you|playlist|downloads)/.test(id) || id.startsWith('VL')) return 'playlist';
    if (id.startsWith('UC')) return 'channel';
    return 'other';
  }
  function currentVideoId() {
    try { return new URLSearchParams(location.search).get('v'); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------------------
  // Classification + decisions
  // ---------------------------------------------------------------------------
  function profileFor(meta) {
    const key = meta.id || meta.title;
    let prof = profiles.get(key);
    if (!prof) {
      prof = C.classify(meta);
      if (meta.id && aiCache[meta.id]) prof = C.mergeAi(prof, aiCache[meta.id]);
      profiles.set(key, prof);
      if (S.aiEnabled && meta.id && !aiCache[meta.id] && meta.kind === 'video' && !meta.isShort) aiEnqueue(meta);
    }
    return prof;
  }

  function evaluate(meta, context) {
    const prof = profileFor(meta);
    const d = P.decide(meta, prof, S, { context, infoUsed: infoUsed() });
    const prev = verdicts.get(meta.id);
    verdicts.set(meta.id, { meta, prof, d, context });
    if (!prev || prev.d.action !== d.action) {
      if (d.action !== 'show') {
        // one entry per video: a reload re-evaluates the same items
        filterLog = filterLog.filter(x => x.id !== meta.id);
        filterLog.push({ id: meta.id, title: meta.title, channel: meta.channel, reason: d.reason, action: d.action, at: Date.now() });
        if (filterLog.length > 200) filterLog = filterLog.slice(-150);
      }
      if (d.action === 'shelf') autoShelf(meta, prof, d.reason);
      persistSoon();
    }
    return d;
  }

  function autoShelf(meta, prof, reason) {
    if (!meta.id) return;
    const lg = letGoIds[meta.id];
    if (lg && Date.now() - lg < 30 * 86400000) return;
    if (infoState.ids.includes(meta.id)) return;
    const r = P.shelfAdd(shelf, {
      id: meta.id, title: meta.title, channel: meta.channel, durationText: meta.durationText,
      load: prof.load, topics: prof.topics, source: 'auto', reason,
    }, S);
    shelf = r.shelf;
    for (const x of r.letGo) { letGoIds[x.id] = Date.now(); shelfStats.letGo++; }
    updateFabDot();
  }

  function saveToShelf(meta) {
    const prof = profileFor(meta);
    const r = P.shelfAdd(shelf, {
      id: meta.id, title: meta.title, channel: meta.channel, durationText: meta.durationText,
      load: prof.load, topics: prof.topics, source: 'saved', reason: 'saved by you',
    }, S);
    shelf = r.shelf;
    for (const x of r.letGo) { letGoIds[x.id] = Date.now(); shelfStats.letGo++; }
    persistSoon(); updateFabDot();
  }

  function letGo(id) {
    shelf = shelf.filter(x => x.id !== id);
    letGoIds[id] = Date.now(); shelfStats.letGo++;
    persistSoon(); updateFabDot();
  }

  function expireShelf() {
    const r = P.shelfExpire(shelf, S);
    if (r.letGo.length) {
      shelf = r.shelf;
      for (const x of r.letGo) { letGoIds[x.id] = Date.now(); shelfStats.letGo++; }
      persistSoon();
    }
    for (const id of Object.keys(letGoIds)) if (Date.now() - letGoIds[id] > 40 * 86400000) delete letGoIds[id];
  }

  // ---------------------------------------------------------------------------
  // JSON interception
  // ---------------------------------------------------------------------------
  function apiKind(url) {
    const m = /\/youtubei\/v1\/(browse|next|search|player|guide)(?:\?|$)/.exec(String(url || ''));
    return m ? m[1] : null;
  }

  function transform(kind, json, reqBody) {
    if (!json || typeof json !== 'object' || !S.enabled) return json;
    let body = null;
    try { body = reqBody ? JSON.parse(reqBody) : null; } catch (e) { /* ignore */ }
    try {
      if (kind === 'player') return X.prunePlayer(json, { hideEndscreens: S.hideEndscreens });
      if (kind === 'guide') return json;
      if (kind === 'next' || (kind === 'initial' && X.isWatchNext(json))) {
        const vid = (body && body.videoId) || currentVideoId();
        if (S.disableAutoplay) X.pruneAutoplay(json);
        if (S.hideRelated) {
          X.prune(json, { watchPage: true, currentVideoId: vid, hideAds: S.hideAds, hideShorts: S.hideShorts });
        } else {
          X.prune(json, { decide: m => toVerdict(evaluate(m, 'related')), hideAds: S.hideAds, hideShorts: S.hideShorts });
        }
        return json;
      }
      let context = contextFromBrowseId(body && body.browseId);
      if (!context) context = kind === 'search' ? 'search' : pageContext();
      if (context === 'watch') context = 'related';
      X.prune(json, {
        decide: m => (m.id ? toVerdict(evaluate(m, context)) : { remove: false }),
        hideAds: S.hideAds, hideShorts: S.hideShorts,
      });
    } catch (e) {
      console.warn('[MindfulFeed] transform failed', e);
    }
    return json;
  }
  function toVerdict(d) { return { remove: d.action !== 'show', reason: d.reason }; }

  function transformText(kind, raw, reqBody) {
    if (typeof raw !== 'string') return raw;
    let prefix = '';
    let txt = raw;
    if (txt.startsWith(")]}'")) { const nl = txt.indexOf('\n'); prefix = txt.slice(0, nl + 1); txt = txt.slice(nl + 1); }
    try { return prefix + JSON.stringify(transform(kind, JSON.parse(txt), reqBody)); } catch (e) { return raw; }
  }

  // fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const kind = apiKind(url);
      if (!kind || !S.enabled) return origFetch.apply(this, arguments);
      let reqBody = init && typeof init.body === 'string' ? init.body : null;
      if (!reqBody && input && typeof input === 'object' && typeof input.clone === 'function') {
        try { reqBody = await input.clone().text(); } catch (e) { /* ignore */ }
      }
      const resp = await origFetch.apply(this, arguments);
      try {
        if (!resp.ok) return resp;
        const raw = await resp.clone().text();
        const out = transformText(kind, raw, reqBody);
        const headers = new Headers(resp.headers);
        headers.delete('content-length'); headers.delete('content-encoding');
        const r = new Response(out, { status: resp.status, statusText: resp.statusText, headers });
        try { Object.defineProperty(r, 'url', { value: resp.url }); } catch (e) { /* ignore */ }
        return r;
      } catch (e) {
        return resp;
      }
    };
  }

  // XMLHttpRequest
  (function patchXhr() {
    const proto = XMLHttpRequest.prototype;
    const open = proto.open, send = proto.send;
    const rtDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
    const rDesc = Object.getOwnPropertyDescriptor(proto, 'response');
    if (!rtDesc || !rDesc) return;
    proto.open = function (method, url) { this.__mfUrl = String(url); return open.apply(this, arguments); };
    proto.send = function (body) {
      const kind = apiKind(this.__mfUrl);
      if (kind && S.enabled) {
        const xhr = this;
        const reqBody = typeof body === 'string' ? body : null;
        let cachedText = null, cachedObj = null;
        Object.defineProperty(xhr, 'responseText', {
          configurable: true,
          get() {
            const raw = rtDesc.get.call(xhr);
            if (xhr.readyState !== 4) return raw;
            if (cachedText === null) cachedText = transformText(kind, raw, reqBody);
            return cachedText;
          },
        });
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get() {
            const raw = rDesc.get.call(xhr);
            if (xhr.readyState !== 4) return raw;
            const rt = xhr.responseType;
            if (rt === '' || rt === 'text') { if (cachedText === null) cachedText = transformText(kind, raw, reqBody); return cachedText; }
            if (rt === 'json') { if (cachedObj === null) cachedObj = transform(kind, raw, reqBody); return cachedObj; }
            return raw;
          },
        });
      }
      return send.apply(this, arguments);
    };
  })();

  // ytInitialData / ytInitialPlayerResponse (embedded in the first HTML page)
  function hookGlobal(name, kind) {
    let value;
    const apply = v => {
      if (v == null) return v;
      if (typeof v === 'string') return transformText(kind, v, null);
      return transform(kind, v, null);
    };
    try { if (window[name] !== undefined) value = apply(window[name]); } catch (e) { /* ignore */ }
    try {
      Object.defineProperty(window, name, {
        configurable: true, enumerable: true,
        get() { return value; },
        set(v) { value = apply(v); },
      });
    } catch (e) { /* ignore */ }
  }
  hookGlobal('ytInitialData', 'initial');
  hookGlobal('ytInitialPlayerResponse', 'player');

  // ---------------------------------------------------------------------------
  // DOM safety net
  // ---------------------------------------------------------------------------
  const CARD_SEL = [
    'ytm-rich-item-renderer', 'ytm-video-with-context-renderer', 'ytm-compact-video-renderer',
    'ytm-media-item', 'ytm-reel-item-renderer', 'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2', 'ytm-lockup-view-model', 'yt-lockup-view-model',
    'ytm-compact-radio-renderer', 'ytm-video-card-renderer', 'ytm-compact-autoplay-renderer',
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-reel-item-renderer', 'ytd-compact-radio-renderer',
  ].join(',');
  const PROTECTED_SEL = [
    'ytm-playlist-panel-renderer', 'ytd-playlist-panel-renderer', 'ytm-playlist-video-list-renderer',
    'ytd-playlist-video-list-renderer', 'ytm-playlist-panel-video-renderer', 'ytd-playlist-panel-video-renderer',
  ].join(',');

  function baseCss() {
    const rules = [];
    rules.push('.mf-hidden{display:none!important}');
    rules.push('.mf-badge{display:inline-flex;gap:4px;align-items:center;margin:2px 12px 6px;padding:2px 8px;border-radius:999px;font:500 11px/1.6 Roboto,Arial,sans-serif;background:rgba(127,127,127,.15);color:inherit;opacity:.85;width:max-content;max-width:90%}');
    if (S.hideShorts) {
      rules.push('ytm-reel-shelf-renderer,ytm-shorts-lockup-view-model,ytm-shorts-lockup-view-model-v2,ytd-reel-shelf-renderer,ytd-rich-shelf-renderer[is-shorts],grid-shelf-view-model:has(ytm-shorts-lockup-view-model),ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model),ytm-rich-section-renderer:has(ytm-reel-shelf-renderer),ytm-pivot-bar-item-renderer:has(.pivot-shorts),ytd-guide-entry-renderer:has(a[title="Shorts"]),ytd-mini-guide-entry-renderer[aria-label="Shorts"]{display:none!important}');
    }
    if (S.hideAds) {
      rules.push('ytm-promoted-sparkles-web-renderer,ytm-companion-ad-renderer,ad-slot-renderer,ytm-ad-slot-renderer,ytd-ad-slot-renderer,ytm-rich-item-renderer:has(ad-slot-renderer),ytd-rich-item-renderer:has(ytd-ad-slot-renderer){display:none!important}');
    }
    if (S.hideRelated) {
      rules.push('html.mf-watch ytm-item-section-renderer[section-identifier="related-items"],html.mf-watch ytm-watch-next-secondary-results-renderer,html.mf-watch ytd-watch-next-secondary-results-renderer,html.mf-watch #related,html.mf-watch ytm-compact-autoplay-renderer,html.mf-watch ytm-single-column-watch-next-results-renderer ytm-reel-shelf-renderer,html.mf-watch ytm-single-column-watch-next-results-renderer ytm-horizontal-card-list-renderer,html.mf-watch ytm-merch-shelf-renderer,html.mf-watch ytd-merch-shelf-renderer{display:none!important}');
    }
    if (S.hideEndscreens) {
      rules.push('.ytp-ce-element,.ytp-endscreen-content,.ytp-videowall-still,.videowall-endscreen,.ytp-suggestion-set,.ytp-pause-overlay,.ytp-autonav-endscreen,.ytm-autonav-endscreen,.ytp-fullscreen-grid,.ytp-fullerscreen-edu-button,.ytp-modern-videowall-still{display:none!important}');
    }
    if (S.disableAutoplay) {
      rules.push('.ytm-autonav-toggle-button-container,ytm-autonav-toggle-button-container,.ytp-autonav-toggle-button-container,.ytp-autonav-toggle{display:none!important}');
    }
    if (S.hideCommentsCompletely) {
      rules.push('ytm-comments-entry-point-header-renderer,ytm-comment-section-renderer,ytm-engagement-panel-section-list-renderer[target-id*="comment"],ytd-comments,#comments{display:none!important}');
    }
    return rules.join('\n');
  }

  function applyCss() {
    if (!document.documentElement) return;
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'mindful-feed-css'; }
    styleEl.textContent = baseCss();
    if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
  }

  function idFromHref(href) {
    if (!href) return null;
    let m = /[?&]v=([\w-]{11})/.exec(href); if (m) return m[1];
    m = /\/shorts\/([\w-]{11})/.exec(href); if (m) return m[1];
    return null;
  }

  function cardMeta(card) {
    const a = card.querySelector('a[href*="watch?v="],a[href*="/shorts/"]');
    const href = a ? a.getAttribute('href') : '';
    const id = idFromHref(href);
    const titleEl = card.querySelector('h3,h4,#video-title,.media-item-headline,[role="heading"],.yt-core-attributed-string');
    const title = ((titleEl && titleEl.textContent) || (a && a.getAttribute('aria-label')) || '').trim();
    const all = (card.innerText || card.textContent || '').trim();
    const durMatch = all.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/);
    const tag = card.tagName.toLowerCase();
    return {
      id, title, channel: '', description: all.slice(0, 400),
      durationText: durMatch ? durMatch[1] : null,
      isShort: /\/shorts\//.test(href) || /shorts|reel/.test(tag),
      isLive: /\bLIVE\b/.test(all), kind: /radio/.test(tag) ? 'mix' : 'video',
    };
  }

  function scanDom() {
    if (!S.enabled || !document.body) return;
    const ctx = pageContext();
    document.documentElement.classList.toggle('mf-watch', ctx === 'watch');
    const vid = currentVideoId();
    const cards = document.querySelectorAll(CARD_SEL);
    for (const card of cards) {
      if (card.closest(PROTECTED_SEL)) continue;
      if (card.parentElement && card.parentElement.closest(CARD_SEL)) continue; // nested; outer handles it
      const meta = cardMeta(card);
      if (!meta.id) continue;
      let action;
      if (ctx === 'watch' && S.hideRelated) {
        action = meta.id === vid ? 'show' : 'hide';
      } else {
        // Prefer the richer metadata we saw in YouTube's JSON for this video.
        const known = verdicts.get(meta.id);
        const m = known ? known.meta : meta;
        if (!m.title) continue;
        action = evaluate(m, normalizeCtx(ctx)).action;
        if (action === 'show' && S.showBadges && (ctx === 'home' || ctx === 'subscriptions')) addBadge(card, meta.id);
      }
      card.classList.toggle('mf-hidden', action !== 'show');
    }
  }
  function normalizeCtx(c) { return c === 'watch' ? 'related' : c; }

  const NEED_ICON = { relax: '🌿', laugh: '😄', curious: '🤔', learn: '📚', create: '🛠️', inspire: '🌱', comfort: '🫶' };
  const LOAD_LABEL = ['easy', 'medium', 'demanding'];
  function addBadge(card, id) {
    if (card.querySelector(':scope > .mf-badge')) return;
    const v = verdicts.get(id); if (!v) return;
    const p = v.prof;
    const icons = (p.needs || []).map(n => NEED_ICON[n]).filter(Boolean).slice(0, 3).join('');
    const label = (icons ? icons + ' ' : '') + LOAD_LABEL[p.load] + (p.tone === 'light' ? ' · light' : '') + (p.source === 'ai' ? ' · ✦' : '');
    const b = document.createElement('div');
    b.className = 'mf-badge'; b.textContent = label;
    b.title = (p.reasons || []).join('\n');
    card.appendChild(b);
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; try { scanDom(); } catch (e) { console.warn('[MindfulFeed] scan', e); } }, 120);
  }

  // ---------------------------------------------------------------------------
  // Navigation & watch tracking
  // ---------------------------------------------------------------------------
  function onNavigate() {
    if (location.href === lastHref && lastWatched) return;
    lastHref = location.href;
    document.documentElement.classList.toggle('mf-watch', pageContext() === 'watch');
    updateWatchChip();
    queueScan();
    const vid = currentVideoId();
    if (pageContext() === 'watch' && vid && vid !== lastWatched) {
      lastWatched = vid;
      setTimeout(() => recordWatch(vid), 2500);
    }
  }

  function recordWatch(vid) {
    if (currentVideoId() !== vid) return;
    let v = verdicts.get(vid);
    let prof = v && v.prof;
    const onShelf = shelf.find(x => x.id === vid);
    if (!prof) {
      const title = (document.title || '').replace(/\s*-\s*YouTube\s*$/, '');
      prof = C.classify({ id: vid, title });
      if (onShelf) prof.informational = true;
    }
    refreshInfoWindow();
    if (prof.informational && !infoState.ids.includes(vid)) {
      infoState.count++; infoState.ids.push(vid);
      if (infoState.ids.length > 50) infoState.ids = infoState.ids.slice(-50);
    }
    if (onShelf) { shelf = shelf.filter(x => x.id !== vid); shelfStats.watched++; }
    persistSoon(); updateFabDot();
    if (panelOpen) renderPanel();
  }

  ['pushState', 'replaceState'].forEach(fn => {
    const orig = history[fn];
    history[fn] = function () { const r = orig.apply(this, arguments); setTimeout(onNavigate, 0); return r; };
  });
  window.addEventListener('popstate', () => setTimeout(onNavigate, 0));
  window.addEventListener('yt-navigate-finish', () => setTimeout(onNavigate, 0));
  window.addEventListener('state-navigateend', () => setTimeout(onNavigate, 0));
  setInterval(() => { if (location.href !== lastHref) onNavigate(); }, 1000);

  // ---------------------------------------------------------------------------
  // AI bridge (Android host). Results refine the heuristic labels.
  // ---------------------------------------------------------------------------

  function aiEnqueue(meta) {
    if (!native || !S.aiEnabled) return;
    if (aiQueue.some(m => m.id === meta.id) || aiPending.has(meta.id)) return;
    aiQueue.push(meta);
    clearTimeout(aiEnqueue.t);
    aiEnqueue.t = setTimeout(aiFlush, 1200);
  }
  function aiFlush() {
    if (!native || !aiQueue.length || aiInFlight >= 2) return;
    const batch = aiQueue.splice(0, 20);
    const reqId = 'r' + (aiReqSeq++);
    for (const m of batch) aiPending.set(m.id, reqId);
    aiInFlight++; aiStatus = 'classifying ' + batch.length + '…';
    try {
      native.postMessage(JSON.stringify({
        type: 'classify', requestId: reqId, model: S.aiModel, needs: C.NEEDS, topics: C.TOPICS,
        items: batch.map(m => ({ id: m.id, title: m.title, channel: m.channel || '', duration: m.durationText || '', snippet: (m.description || '').slice(0, 200) })),
      }));
    } catch (e) { aiInFlight--; aiStatus = 'error: ' + e.message; }
  }
  function initNative() {
    if (native || !window.MindfulNative) return;
    native = window.MindfulNative;
    aiStatus = 'idle';
    native.onmessage = function (ev) {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'classifyResult') {
        aiInFlight = Math.max(0, aiInFlight - 1);
        for (const r of msg.results || []) {
          if (!r || !r.id) continue;
          aiCache[r.id] = r; aiPending.delete(r.id);
          const v = verdicts.get(r.id);
          profiles.delete(r.id);
          if (v) evaluate(v.meta, v.context);
        }
        for (const [id, req] of aiPending) if (req === msg.requestId) aiPending.delete(id);
        aiStatus = 'ok – ' + Object.keys(aiCache).length + ' videos classified';
        persistSoon(); queueScan();
        if (aiQueue.length) setTimeout(aiFlush, 300);
      } else if (msg.type === 'error') {
        aiInFlight = Math.max(0, aiInFlight - 1);
        for (const [id, req] of aiPending) if (req === msg.requestId) aiPending.delete(id);
        aiStatus = 'error: ' + msg.message;
      } else if (msg.type === 'status') {
        aiStatus = msg.hasKey ? (S.aiEnabled ? 'ready' : 'key saved – enable AI below') : 'no API key yet';
      }
      if (panelOpen && activeTab === 'ai') renderPanel();
    };
    try { native.postMessage(JSON.stringify({ type: 'status' })); } catch (e) { /* ignore */ }
  }
  initNative();

  // ---------------------------------------------------------------------------
  // UI (shadow DOM)
  // ---------------------------------------------------------------------------
  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.setAttribute('style', v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(x => x != null && x !== false && el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  const UI_CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .wrap{--bg:#fbfaf7;--fg:#22211f;--mut:#6b6862;--line:#e5e1d8;--acc:#3f7d6b;--acc2:#e7f1ed;--warn:#a5562f;
    font:14px/1.45 system-ui,-apple-system,Roboto,"Segoe UI",sans-serif;color:var(--fg)}
  @media (prefers-color-scheme:dark){.wrap{--bg:#1d1f1e;--fg:#ecebe7;--mut:#a5a39d;--line:#353836;--acc:#7cc2ab;--acc2:#24342f;--warn:#e19a76}}
  .fab{position:fixed;right:14px;bottom:72px;z-index:2147483000;width:48px;height:48px;border-radius:50%;border:none;
    background:var(--acc);color:#fff;font-size:22px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
  .fab .dot{position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;background:#f2c14e;border:2px solid var(--acc)}
  .chip{position:fixed;right:70px;bottom:80px;z-index:2147483000;border:none;border-radius:999px;padding:8px 12px;
    background:var(--bg);color:var(--fg);box-shadow:0 2px 10px rgba(0,0,0,.2);font:500 13px system-ui,sans-serif;cursor:pointer}
  .sheet{position:fixed;inset:auto 0 0 0;z-index:2147483001;max-height:88vh;overflow:auto;background:var(--bg);
    border-radius:18px 18px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.3);padding:14px 16px 28px}
  @media (min-width:700px){.sheet{left:auto;right:16px;bottom:16px;width:420px;border-radius:18px}}
  .scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.35)}
  .top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
  h2{font-size:17px;margin:0}
  h3{font-size:13px;margin:16px 0 6px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
  .x{border:none;background:transparent;font-size:22px;color:var(--mut);cursor:pointer}
  .tabs{display:flex;gap:4px;overflow-x:auto;margin:4px -4px 10px;padding:0 4px}
  .tab{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:6px 12px;font:inherit;white-space:nowrap;cursor:pointer}
  .tab.on{background:var(--acc);border-color:var(--acc);color:#fff}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
  .preset{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:14px;padding:10px;text-align:left;font:inherit;cursor:pointer}
  .preset.on{border-color:var(--acc);background:var(--acc2)}
  .preset b{display:block;font-size:20px;margin-bottom:2px}
  .preset small{display:block;color:var(--mut);font-size:11.5px;line-height:1.3}
  .row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}
  .row label{flex:1}
  .row small{display:block;color:var(--mut);font-size:12px}
  .seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;flex-shrink:0}
  .seg button{border:none;background:transparent;color:var(--fg);padding:5px 10px;font:inherit;font-size:12.5px;cursor:pointer}
  .seg button.on{background:var(--acc);color:#fff}
  select,input[type=number],textarea{font:inherit;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:8px;padding:5px 8px}
  textarea{width:100%;min-height:54px;resize:vertical}
  input[type=checkbox]{width:20px;height:20px;accent-color:var(--acc)}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .tchip{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:4px 10px;font:inherit;font-size:12.5px;cursor:pointer}
  .tchip.on{background:var(--acc2);border-color:var(--acc)}
  .tchip.block{background:rgba(165,86,47,.12);border-color:var(--warn);text-decoration:line-through}
  .card{border:1px solid var(--line);border-radius:14px;padding:10px;display:flex;gap:10px;align-items:flex-start;margin:8px 0}
  .card img{width:120px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;flex-shrink:0;background:var(--line)}
  .card .t{font-weight:600;margin-bottom:2px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .card .m{color:var(--mut);font-size:12px}
  .btns{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
  .btn{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
  .btn.p{background:var(--acc);border-color:var(--acc);color:#fff}
  .note{color:var(--mut);font-size:12.5px;margin:6px 0}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--acc2);font-size:12px;margin:2px 4px 2px 0}
  .log{font-size:12.5px;border-bottom:1px solid var(--line);padding:6px 0}
  .log .r{color:var(--mut)}
  .big{font-size:15px;margin:2px 0 10px}
  `;


  function mountUi() {
    if (host || !document.body) return;
    host = h('div', { id: 'mindful-feed-ui' });
    shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('style', { text: UI_CSS }));
    wrapEl = h('div', { class: 'wrap' });
    shadow.appendChild(wrapEl);
    fabEl = h('button', { class: 'fab', 'aria-label': 'Mindful Feed', title: 'Mindful Feed', onclick: () => { panelOpen ? closePanel() : openPanel('now'); } }, '🧭');
    wrapEl.appendChild(fabEl);
    chipEl = h('button', { class: 'chip', style: 'display:none', onclick: () => {
      const vid = currentVideoId(); if (!vid) return;
      const title = (document.title || '').replace(/\s*-\s*YouTube\s*$/, '');
      const v = verdicts.get(vid);
      saveToShelf(v ? v.meta : { id: vid, title, channel: '', kind: 'video' });
      chipEl.textContent = '✓ On your shelf';
    } }, '＋ Later shelf');
    wrapEl.appendChild(chipEl);
    document.body.appendChild(host);
    updateFabDot(); updateWatchChip();
  }

  function updateWatchChip() {
    if (!chipEl) return;
    const vid = currentVideoId();
    const show = pageContext() === 'watch' && S.shelfEnabled && !!vid;
    chipEl.style.display = show ? '' : 'none';
    if (show) chipEl.textContent = shelf.some(x => x.id === vid) ? '✓ On your shelf' : '＋ Later shelf';
  }

  function updateFabDot() {
    if (!fabEl) return;
    const old = fabEl.querySelector('.dot'); if (old) old.remove();
    const budgetLeft = (S.infoBudget || 0) - infoUsed();
    const wantsInfo = ['any', 'curious', 'learn', 'create'].includes(S.need);
    if (shelf.length && budgetLeft > 0 && wantsInfo) fabEl.appendChild(h('span', { class: 'dot', title: 'Something from your shelf fits right now' }));
  }

  function openPanel(tab) { panelOpen = true; activeTab = tab || activeTab; renderPanel(); }
  function closePanel() { panelOpen = false; checkInOpen = false; renderPanel(); if (dirty) reloadIfFeed(); }

  function renderPanel() {
    if (!wrapEl) return;
    for (const el of Array.from(wrapEl.querySelectorAll('.sheet,.scrim'))) el.remove();
    if (!panelOpen && !checkInOpen) return;
    wrapEl.appendChild(h('div', { class: 'scrim', onclick: closePanel }));
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Mindful Feed' });
    if (checkInOpen) { renderCheckIn(sheet); wrapEl.appendChild(sheet); return; }
    sheet.appendChild(h('div', { class: 'top' },
      h('h2', { text: '🧭 Mindful Feed' }),
      h('div', null,
        h('button', { class: 'btn', onclick: () => { S.enabled = !S.enabled; saveSettings(); reloadIfFeed(true); renderPanel(); } }, S.enabled ? 'Pause' : 'Resume'),
        h('button', { class: 'x', 'aria-label': 'Close', onclick: closePanel }, '×'))));
    const tabs = [['now', 'Right now'], ['shelf', 'Shelf (' + shelf.length + ')'], ['filters', 'Filters'], ['log', 'Filtered'], ['ai', 'AI']];
    sheet.appendChild(h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: 'tab' + (activeTab === k ? ' on' : ''), onclick: () => { activeTab = k; renderPanel(); } }, l))));
    const body = h('div');
    ({ now: renderNow, shelf: renderShelf, filters: renderFilters, log: renderLog, ai: renderAi })[activeTab](body);
    sheet.appendChild(body);
    wrapEl.appendChild(sheet);
  }

  function presetGrid(onPick) {
    return h('div', { class: 'grid' }, Object.keys(P.PRESETS).map(k => {
      const pr = P.PRESETS[k];
      return h('button', { class: 'preset' + (currentPreset === k ? ' on' : ''), onclick: () => onPick(k) },
        h('b', { text: pr.emoji }), pr.label, h('small', { text: pr.hint }));
    }));
  }

  function applyPreset(k) {
    Object.assign(S, P.PRESETS[k].set);
    currentPreset = k; store.set('preset', k);
    lastCheckIn = Date.now(); store.set('lastCheckIn', lastCheckIn);
    saveSettings();
  }

  function renderCheckIn(sheet) {
    sheet.appendChild(h('div', { class: 'top' }, h('h2', { text: 'How are you right now?' }),
      h('button', { class: 'x', 'aria-label': 'Close', onclick: () => { lastCheckIn = Date.now(); store.set('lastCheckIn', lastCheckIn); closePanel(); } }, '×')));
    sheet.appendChild(h('p', { class: 'note', text: 'Your feed will only show what fits. Nothing informational gets lost – it waits on your Later shelf.' }));
    sheet.appendChild(presetGrid(k => { applyPreset(k); checkInOpen = false; panelOpen = false; renderPanel(); reloadIfFeed(true); }));
    sheet.appendChild(h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { lastCheckIn = Date.now(); store.set('lastCheckIn', lastCheckIn); checkInOpen = false; openPanel('now'); } }, 'Fine-tune instead')));
  }

  function seg(options, value, onChange) {
    return h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { class: value === v ? 'on' : '', onclick: () => onChange(v) }, l)));
  }
  function row(label, hint, control) {
    return h('div', { class: 'row' }, h('label', null, label, hint ? h('small', { text: hint }) : null), control);
  }
  function check(key, after) {
    const c = h('input', { type: 'checkbox' });
    c.checked = !!S[key];
    c.addEventListener('change', () => { S[key] = c.checked; saveSettings(); applyCss(); if (after) after(); queueScan(); });
    return c;
  }
  function setAndRefresh(key, v) { S[key] = v; currentPreset = null; store.set('preset', null); saveSettings(); renderPanel(); markDirty(); }

  // Settings changes are applied when the panel closes: feeds are reloaded so
  // YouTube's response is filtered again with the new settings.
  function markDirty() { dirty = true; }
  function reloadIfFeed(force) {
    const c = pageContext();
    const wasDirty = dirty; dirty = false;
    if ((force || wasDirty) && (c === 'home' || c === 'subscriptions')) location.reload();
    else queueScan();
  }

  function renderNow(b) {
    const budgetLeft = Math.max(0, (S.infoBudget || 0) - infoUsed());
    b.appendChild(h('p', { class: 'big' }, currentPreset ? (P.PRESETS[currentPreset].emoji + ' ' + P.PRESETS[currentPreset].label) : 'Custom mix'));
    b.appendChild(presetGrid(k => { applyPreset(k); renderPanel(); markDirty(); }));
    b.appendChild(h('h3', { text: 'Fine-tune' }));
    const needSel = h('select', { onchange: e => setAndRefresh('need', e.target.value) },
      Object.keys(P.NEED_LABELS).map(k => { const o = h('option', { value: k }, P.NEED_LABELS[k]); if (S.need === k) o.selected = true; return o; }));
    b.appendChild(row('What do you need?', 'Psychological need the feed should serve', needSel));
    b.appendChild(row('Mental capacity', 'How demanding videos may be', seg([[0, 'Relaxed'], [1, 'In-between'], [2, 'Strenuous']], S.maxLoad, v => setAndRefresh('maxLoad', v))));
    b.appendChild(row('Tone', null, seg([['light', 'Light-hearted'], ['balanced', 'Balanced'], ['any', 'Anything']], S.tone, v => setAndRefresh('tone', v))));
    b.appendChild(row('Politics', null, seg([['hide', 'Apolitical'], ['show', 'Political ok']], S.politics, v => setAndRefresh('politics', v))));
    b.appendChild(row('News', null, seg([['hide', 'No news'], ['show', 'News ok']], S.news, v => setAndRefresh('news', v))));
    b.appendChild(row('Distressing topics', 'Crime, war, disasters, horror', seg([['hide', 'Hide'], ['show', 'Allow']], S.distressing, v => setAndRefresh('distressing', v))));
    b.appendChild(h('h3', { text: 'Informational videos' }));
    b.appendChild(h('p', { class: 'note' }, 'Today: ' + infoUsed() + ' of ' + S.infoBudget + ' watched. ' +
      (budgetLeft > 0 ? 'You have room for ' + budgetLeft + ' more.' : "That's enough input for now – new ones wait on your shelf.")));
    const next = P.shelfNext(shelf, S);
    if (next && budgetLeft > 0) { b.appendChild(h('p', { class: 'note', text: 'Next up from your shelf:' })); b.appendChild(shelfCard(next, true)); }
    b.appendChild(h('div', { class: 'btns' }, h('button', { class: 'btn p', onclick: () => { markDirty(); closePanel(); } }, 'Apply to feed')));
  }

  function shelfCard(x, primary) {
    return h('div', { class: 'card' },
      h('img', { src: 'https://i.ytimg.com/vi/' + encodeURIComponent(x.id) + '/mqdefault.jpg', alt: '', loading: 'lazy' }),
      h('div', null,
        h('div', { class: 't', text: x.title || x.id }),
        h('div', { class: 'm', text: [x.channel, x.durationText, x.source === 'saved' ? 'saved by you' : 'caught for you', ago(x.addedAt)].filter(Boolean).join(' · ') }),
        h('div', { class: 'btns' },
          h('button', { class: 'btn' + (primary ? ' p' : ''), onclick: () => { closePanel(); location.href = '/watch?v=' + encodeURIComponent(x.id); } }, 'Watch'),
          h('button', { class: 'btn', onclick: () => { letGo(x.id); renderPanel(); } }, 'Let go'))));
  }
  function ago(t) {
    if (!t) return '';
    const d = Math.floor((Date.now() - t) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  }

  function renderShelf(b) {
    expireShelf();
    b.appendChild(h('p', { class: 'note' },
      'A small shelf, not a pile. It holds at most ' + S.shelfMax + ' videos; things you didn\'t save yourself are let go after ' +
      S.shelfAutoExpireDays + ' days, saved ones after ' + S.shelfExpireDays + '. If a topic really matters, it will come around again.'));
    if (!shelf.length) { b.appendChild(h('p', { class: 'big', text: 'Your shelf is empty. Nothing is waiting for you. 🌿' })); }
    else {
      const next = P.shelfNext(shelf, S);
      const budgetLeft = Math.max(0, (S.infoBudget || 0) - infoUsed());
      b.appendChild(h('h3', { text: !next ? 'Waiting for a day with more capacity' : budgetLeft > 0 ? 'One thing, when you are ready' : 'Waiting quietly (you\'ve had enough input today)' }));
      if (next) b.appendChild(shelfCard(next, budgetLeft > 0));
      else b.appendChild(h('p', { class: 'note', text: 'Nothing here fits your current capacity – and that is fine. It will wait.' }));
      const rest = shelf.filter(x => !next || x.id !== next.id);
      if (rest.length) {
        const det = h('details', null, h('summary', { text: rest.length + (next ? ' more' : '') + ' on the shelf' }));
        rest.sort((a, c) => c.addedAt - a.addedAt).forEach(x => det.appendChild(shelfCard(x, false)));
        b.appendChild(det);
      }
      b.appendChild(h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { for (const x of shelf) { letGoIds[x.id] = Date.now(); shelfStats.letGo++; } shelf = []; persistSoon(); updateFabDot(); renderPanel(); } }, 'Let everything go')));
    }
    b.appendChild(h('p', { class: 'note', text: 'Since you started: ' + shelfStats.watched + ' watched from the shelf, ' + shelfStats.letGo + ' gracefully let go.' }));
  }

  function topicChips(onlyMode) {
    const key = onlyMode ? 'topicsOnly' : 'topicsBlocked';
    return h('div', { class: 'chips' }, C.TOPICS.map(t => {
      const on = (S[key] || []).includes(t);
      return h('button', { class: 'tchip' + (on ? (onlyMode ? ' on' : ' block') : ''), onclick: () => {
        const list = new Set(S[key] || []); on ? list.delete(t) : list.add(t); S[key] = Array.from(list); saveSettings(); markDirty(); renderPanel();
      } }, t);
    }));
  }
  function listArea(key, placeholder) {
    const ta = h('textarea', { placeholder });
    ta.value = (S[key] || []).join(', ');
    ta.addEventListener('change', () => { S[key] = ta.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean); saveSettings(); markDirty(); });
    return ta;
  }
  function num(key, min, max) {
    const i = h('input', { type: 'number', min: String(min), max: String(max), style: 'width:64px' });
    i.value = S[key];
    i.addEventListener('change', () => { const v = Math.max(min, Math.min(max, Number(i.value) || 0)); S[key] = v; saveSettings(); updateFabDot(); });
    return i;
  }

  function renderFilters(b) {
    b.appendChild(h('h3', { text: 'Protections' }));
    b.appendChild(row('Block parasocial videos', 'Vlogs, drama, reactions, “we need to talk”, streams', check('blockParasocial', markDirty)));
    b.appendChild(row('Block addictive patterns', 'Clickbait, rage bait, challenges, pranks', check('blockAddictive', markDirty)));
    b.appendChild(row('Hide Shorts', 'Feed shelves and the Shorts tab', check('hideShorts', markDirty)));
    b.appendChild(row('Hide ad cards in feeds', 'Player ads are not touched', check('hideAds', markDirty)));
    b.appendChild(row('Strict mode', 'Hide videos we can\'t classify when a specific need is chosen', check('strictNeed', markDirty)));
    b.appendChild(h('h3', { text: 'While watching' }));
    b.appendChild(row('No recommendations under videos', 'Also removes suggestions next to comments', check('hideRelated')));
    b.appendChild(row('No end screens / info cards', null, check('hideEndscreens')));
    b.appendChild(row('No autoplay of the next video', null, check('disableAutoplay')));
    b.appendChild(row('Hide comments completely', null, check('hideCommentsCompletely')));
    b.appendChild(h('h3', { text: 'Only these topics' }));
    b.appendChild(h('p', { class: 'note', text: 'Leave empty for all topics.' }));
    b.appendChild(topicChips(true));
    b.appendChild(h('h3', { text: 'Never these topics' }));
    b.appendChild(topicChips(false));
    b.appendChild(h('h3', { text: 'Keywords to block' }));
    b.appendChild(listArea('keywordsBlocked', 'e.g. elden ring spoilers, crypto'));
    b.appendChild(h('h3', { text: 'Blocked channels' }));
    b.appendChild(listArea('channelsBlocked', 'Exact channel names, comma separated'));
    b.appendChild(h('h3', { text: 'Trusted channels (always shown)' }));
    b.appendChild(listArea('channelsTrusted', 'Exact channel names, comma separated'));
    b.appendChild(h('h3', { text: 'Capacity & shelf' }));
    b.appendChild(row('Informational videos per window', null, num('infoBudget', 0, 10)));
    b.appendChild(row('Budget window', null, seg([['day', 'Per day'], ['session', 'Per session']], S.infoBudgetWindow, v => { S.infoBudgetWindow = v; saveSettings(); renderPanel(); })));
    b.appendChild(row('Catch informational videos for later', 'Instead of just hiding them', check('shelfAutoCatch')));
    b.appendChild(row('Shelf size', null, num('shelfMax', 1, 20)));
    b.appendChild(row('Auto-caught: let go after (days)', null, num('shelfAutoExpireDays', 1, 30)));
    b.appendChild(row('Saved: let go after (days)', null, num('shelfExpireDays', 1, 90)));
    b.appendChild(h('h3', { text: 'Other' }));
    b.appendChild(row('Also filter search results', 'Off: searches show what you asked for', check('filterSearch')));
    b.appendChild(row('Show labels on videos', 'Need · load · tone', check('showBadges')));
    b.appendChild(row('Ask how I am every … hours', null, num('checkInEveryHours', 0, 48)));
    b.appendChild(h('div', { class: 'btns' },
      h('button', { class: 'btn p', onclick: () => { markDirty(); closePanel(); } }, 'Apply to feed'),
      h('button', { class: 'btn', onclick: () => { if (confirm('Reset all Mindful Feed settings?')) { S = P.merge(null); saveSettings(); applyCss(); renderPanel(); } } }, 'Reset settings')));
  }

  function renderLog(b) {
    const items = filterLog.slice(-100).reverse();
    b.appendChild(h('p', { class: 'note', text: 'What the algorithm wanted to show you, and why it didn\'t reach you. Tap to watch anyway.' }));
    if (!items.length) b.appendChild(h('p', { text: 'Nothing filtered yet.' }));
    for (const x of items) {
      b.appendChild(h('div', { class: 'log' },
        h('a', { href: '/watch?v=' + encodeURIComponent(x.id), style: 'color:inherit' }, x.title || x.id),
        h('div', { class: 'r', text: (x.channel ? x.channel + ' · ' : '') + (x.action === 'shelf' ? '📥 ' : '🚫 ') + x.reason }),
        x.channel ? h('button', { class: 'tchip', onclick: () => { S.channelsTrusted = Array.from(new Set((S.channelsTrusted || []).concat([x.channel]))); saveSettings(); renderPanel(); } }, 'Trust channel') : null));
    }
    if (items.length) b.appendChild(h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { filterLog = []; persistSoon(); renderPanel(); } }, 'Clear log')));
  }

  function renderAi(b) {
    b.appendChild(h('p', { class: 'note', text: 'Keyword rules work offline and for free. Optionally, Claude can classify each video more accurately (needs your own Anthropic API key; titles and channel names are sent to the API, nothing else).' }));
    if (!native) {
      b.appendChild(h('p', { text: 'AI classification is only available in the Android app.' }));
      return;
    }
    b.appendChild(row('Status', null, h('span', { class: 'pill', text: aiStatus })));
    b.appendChild(row('Use AI classification', null, check('aiEnabled', () => { if (S.aiEnabled) { profiles.clear(); for (const v of verdicts.values()) profileFor(v.meta); } renderPanel(); })));
    const sel = h('select', { onchange: e => { S.aiModel = e.target.value; saveSettings(); } },
      [['claude-opus-5-5', 'Claude Opus 5.5 (most accurate)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (cheaper)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)']]
        .map(([v, l]) => { const o = h('option', { value: v }, l); if (S.aiModel === v) o.selected = true; return o; }));
    b.appendChild(row('Model', null, sel));
    b.appendChild(h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: () => native.postMessage(JSON.stringify({ type: 'openSettings' })) }, 'Set API key'),
      h('button', { class: 'btn', onclick: () => { aiCache = {}; profiles.clear(); persistSoon(); aiStatus = 'cache cleared'; renderPanel(); } }, 'Clear AI cache')));
  }

  function maybeCheckIn() {
    const every = Number(S.checkInEveryHours) || 0;
    if (!every || !S.enabled) return;
    if (Date.now() - lastCheckIn < every * 3600000) return;
    if (pageContext() !== 'home') return;
    checkInOpen = true; renderPanel();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function boot() {
    initNative();
    applyCss();
    expireShelf();
    mountUi();
    const mo = new MutationObserver(queueScan);
    mo.observe(document.body, { childList: true, subtree: true });
    onNavigate();
    setTimeout(maybeCheckIn, 800);
  }
  if (document.documentElement) applyCss();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Exposed for debugging / the Android host.
  window.MindfulFeed = {
    settings: () => S, shelf: () => shelf, verdicts, openPanel,
    checkIn: () => { checkInOpen = true; renderPanel(); },
  };
})();
