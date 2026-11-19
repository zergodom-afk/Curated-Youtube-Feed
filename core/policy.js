/*
 * Mindful Feed – policy: settings, mood presets and the per-video decision.
 *
 * decide() answers one question for every video YouTube wants to show:
 *   'show'  – fits what you need right now
 *   'shelf' – informational and worth keeping, but not for right now
 *             (you're tired, or you've had today's informational video).
 *             It goes onto a small, self-cleaning "Later shelf" so nothing
 *             feels lost – no FOMO, no endless Watch Later pile.
 *   'hide'  – doesn't fit (parasocial, addictive, political when you chose
 *             apolitical, too heavy, wrong need, blocked topic …)
 * Every verdict carries a human-readable reason for the filter log.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    version: 1,
    enabled: true,
    // ---- current state (usually set via a mood preset) ----
    need: 'any',          // any | relax | laugh | curious | learn | create | inspire | comfort
    maxLoad: 1,           // 0 relaxed, 1 in-between, 2 strenuous
    tone: 'balanced',     // light | balanced | any
    politics: 'hide',     // hide | show
    news: 'hide',         // hide | show
    distressing: 'hide',  // hide | show
    // ---- protections ----
    blockParasocial: true,
    parasocialThreshold: 2,
    blockAddictive: true,
    addictiveThreshold: 3,
    hideShorts: true,
    hideAds: false,       // in-feed ad cards only; player ads are never touched
    strictNeed: false,    // hide videos we couldn't classify when a specific need is chosen
    // ---- watch page ----
    hideRelated: true,
    hideEndscreens: true,
    disableAutoplay: true,
    hideCommentsCompletely: false,
    // ---- topics / channels / keywords ----
    topicsOnly: [],       // if non-empty: only these topics (unknown-topic videos stay unless strictTopics)
    strictTopics: false,
    topicsBlocked: [],
    keywordsBlocked: [],
    channelsBlocked: [],
    channelsTrusted: [],  // always shown (still subject to Shorts/ads)
    // ---- information budget & Later shelf ----
    infoBudget: 1,        // informational videos per window
    infoBudgetWindow: 'day', // day | session
    shelfEnabled: true,
    shelfAutoCatch: true, // put informational videos you can't take now on the shelf
    shelfMax: 7,
    shelfAutoMax: 5,      // max automatically caught items (oldest let go first)
    shelfExpireDays: 21,
    shelfAutoExpireDays: 4,
    // ---- search ----
    filterSearch: false,  // in search results only Shorts/ads/hard blocks apply
    // ---- check-in ----
    checkInEveryHours: 3,
    showBadges: true,
    // ---- AI ----
    aiEnabled: false,
    aiModel: 'claude-opus-5-5',
  };

  // One-tap "how are you right now?" presets.
  const PRESETS = {
    drained: {
      emoji: '😮‍💨', label: 'Drained', hint: 'Only calm, light things. No news, no heavy stuff.',
      set: { need: 'relax', maxLoad: 0, tone: 'light', politics: 'hide', news: 'hide', distressing: 'hide' },
    },
    anxious: {
      emoji: '😟', label: 'Anxious / overwhelmed', hint: 'Soothing and comforting. Nothing alarming.',
      set: { need: 'comfort', maxLoad: 0, tone: 'light', politics: 'hide', news: 'hide', distressing: 'hide' },
    },
    unwind: {
      emoji: '🛋️', label: 'Just unwinding', hint: 'Easy entertainment, light curiosity.',
      set: { need: 'any', maxLoad: 1, tone: 'balanced', politics: 'hide', news: 'hide', distressing: 'hide' },
    },
    laugh: {
      emoji: '😂', label: 'Need a laugh', hint: 'Comedy, wholesome and fun.',
      set: { need: 'laugh', maxLoad: 0, tone: 'light', politics: 'hide', news: 'hide', distressing: 'hide' },
    },
    curious: {
      emoji: '🤔', label: 'Curious', hint: 'Interesting things, not too demanding.',
      set: { need: 'curious', maxLoad: 1, tone: 'balanced', politics: 'hide', news: 'hide', distressing: 'hide' },
    },
    focused: {
      emoji: '🧠', label: 'Focused – ready to learn', hint: 'Deep dives and lectures welcome.',
      set: { need: 'learn', maxLoad: 2, tone: 'any', politics: 'show', news: 'show', distressing: 'show' },
    },
    creative: {
      emoji: '🛠️', label: 'Want to make something', hint: 'Recipes, DIY, workouts, tutorials.',
      set: { need: 'create', maxLoad: 1, tone: 'balanced', politics: 'hide', news: 'hide', distressing: 'hide' },
    },
    lowMotivation: {
      emoji: '🌱', label: 'Need a lift', hint: 'Encouraging, inspiring, hopeful.',
      set: { need: 'inspire', maxLoad: 1, tone: 'light', politics: 'hide', news: 'hide', distressing: 'hide' },
    },
    sleep: {
      emoji: '🌙', label: 'Winding down for sleep', hint: 'Calm, slow, nothing stimulating.',
      set: { need: 'relax', maxLoad: 0, tone: 'light', politics: 'hide', news: 'hide', distressing: 'hide' },
    },
  };

  const NEED_LABELS = {
    any: 'Anything that fits', relax: 'Relaxation', laugh: 'Laughter / fun', curious: 'Light curiosity',
    learn: 'Learning', create: 'Doing / making', inspire: 'Inspiration', comfort: 'Comfort / safety',
  };

  // Which classifier needs satisfy a chosen need.
  const NEED_MATCH = {
    relax: ['relax'],
    laugh: ['laugh'],
    curious: ['curious', 'learn'],
    learn: ['learn', 'curious', 'create'],
    create: ['create'],
    inspire: ['inspire', 'comfort'],
    comfort: ['comfort', 'relax', 'laugh'],
  };

  function norm(s) { return String(s || '').toLowerCase().trim(); }
  function listHas(list, value) {
    const v = norm(value);
    return (list || []).some(x => norm(x) && v === norm(x));
  }
  function containsAny(list, text) {
    const t = norm(text);
    return (list || []).find(x => norm(x) && t.includes(norm(x)));
  }

  /**
   * @param meta     {id,title,channel,isShort,isLive,kind,isAd}
   * @param p        classifier profile
   * @param s        settings (DEFAULTS merged)
   * @param ctx      {context:'home'|'search'|'subscriptions'|'channel'|'other', infoUsed:number}
   * @returns {action:'show'|'hide'|'shelf', reason:string}
   */
  function decide(meta, p, s, ctx) {
    ctx = ctx || {};
    if (!s.enabled) return { action: 'show', reason: 'filter paused' };
    if (meta.isAd && s.hideAds) return { action: 'hide', reason: 'ad' };
    if (meta.isShort && s.hideShorts) return { action: 'hide', reason: 'Short (endless-scroll format)' };

    const haystack = (meta.title || '') + ' ' + (meta.channel || '');
    const kw = containsAny(s.keywordsBlocked, haystack);
    if (kw) return { action: 'hide', reason: 'blocked keyword "' + kw + '"' };
    if (listHas(s.channelsBlocked, meta.channel)) return { action: 'hide', reason: 'blocked channel' };
    if (listHas(s.channelsTrusted, meta.channel)) return { action: 'show', reason: 'trusted channel' };

    const blockedTopic = (p.topics || []).find(t => listHas(s.topicsBlocked, t));
    if (blockedTopic) return { action: 'hide', reason: 'blocked topic: ' + blockedTopic };

    // Search & channel pages: the user is looking for something specific.
    if ((ctx.context === 'search' && !s.filterSearch) || ctx.context === 'channel' || ctx.context === 'playlist') {
      return { action: 'show', reason: 'you searched / chose this page' };
    }

    if (s.blockAddictive && p.addictive >= s.addictiveThreshold) return { action: 'hide', reason: 'addictive pattern (' + firstReason(p, /clickbait|typography|Short/) + ')' };
    if (s.blockParasocial && p.parasocial >= s.parasocialThreshold) return { action: 'hide', reason: 'parasocial (' + firstReason(p, /parasocial|stream/) + ')' };
    if (s.politics === 'hide' && p.political) return { action: 'hide', reason: 'political (you chose apolitical)' };
    if (s.news === 'hide' && p.news) return { action: 'hide', reason: 'news (you chose no news)' };
    if (s.distressing === 'hide' && p.distressing) return { action: 'hide', reason: 'distressing content' };
    const topicsOnly = (s.topicsOnly || []).filter(Boolean);
    if (topicsOnly.length) {
      const match = (p.topics || []).some(t => listHas(topicsOnly, t));
      if (!match && ((p.topics || []).length || s.strictTopics)) return { action: 'hide', reason: 'not in your chosen topics' };
    }

    // Informational content: respect capacity and the daily budget, but never
    // lose it – put it on the Later shelf instead.
    if (p.informational) {
      const wantsInfo = s.need === 'any' || s.need === 'curious' || s.need === 'learn' || s.need === 'create';
      const tooHeavy = p.load > s.maxLoad;
      const budgetLeft = (s.infoBudget || 0) - (ctx.infoUsed || 0);
      const toneMismatch = (s.tone === 'light' && p.tone !== 'light') || (s.tone === 'balanced' && p.tone === 'heavy');
      if (!wantsInfo || tooHeavy || budgetLeft <= 0 || toneMismatch) {
        const why = !wantsInfo ? 'informational – not what you need right now'
          : tooHeavy ? 'more demanding than your current capacity'
            : toneMismatch ? 'too serious for your current mood'
              : "you've had today's informational video";
        if (s.shelfEnabled && s.shelfAutoCatch && meta.kind === 'video' && !meta.isShort) return { action: 'shelf', reason: why + ' → kept on your Later shelf' };
        return { action: 'hide', reason: why };
      }
    } else if (p.load > s.maxLoad) {
      return { action: 'hide', reason: 'more demanding than your current capacity' };
    }
    if (s.tone === 'light' && p.tone !== 'light' && p.known) return { action: 'hide', reason: 'not light-hearted (' + p.tone + ')' };
    if (s.tone === 'balanced' && p.tone === 'heavy') return { action: 'hide', reason: 'heavy tone' };

    if (s.need !== 'any') {
      const accepted = NEED_MATCH[s.need] || [s.need];
      const ok = (p.needs || []).some(n => accepted.includes(n));
      if (!ok) {
        if ((p.needs || []).length || p.informational || s.strictNeed) {
          return { action: 'hide', reason: "doesn't serve " + (NEED_LABELS[s.need] || s.need).toLowerCase() };
        }
        // unknown → only allowed if it is at least plausibly gentle
        if (s.maxLoad === 0 && p.tone === 'heavy') return { action: 'hide', reason: 'heavy tone' };
      }
    }
    return { action: 'show', reason: p.known ? 'fits: ' + ((p.needs || []).join(', ') || p.tone) : 'unclassified – shown' };
  }

  function firstReason(p, re) {
    const r = (p.reasons || []).find(x => re.test(x));
    return r || 'pattern';
  }

  // ---------------------------------------------------------------------------
  // Later shelf – a small, self-cleaning list (pure functions over an array)
  // ---------------------------------------------------------------------------
  /** item: {id,title,channel,durationText,addedAt,source:'auto'|'saved',reason} */
  function shelfAdd(shelf, item, s, now) {
    now = now || Date.now();
    shelf = (shelf || []).slice();
    const existing = shelf.find(x => x.id === item.id);
    if (existing) {
      if (item.source === 'saved' && existing.source !== 'saved') { existing.source = 'saved'; existing.addedAt = now; }
      return { shelf, added: false, letGo: [] };
    }
    shelf.push(Object.assign({}, item, { addedAt: now }));
    const letGo = [];
    // Cap automatic catches first (oldest go), then the whole shelf.
    const autos = shelf.filter(x => x.source !== 'saved').sort((a, b) => a.addedAt - b.addedAt);
    while (autos.length > s.shelfAutoMax) { const x = autos.shift(); letGo.push(x); shelf = shelf.filter(y => y !== x); }
    const all = shelf.slice().sort((a, b) => (rank(a) - rank(b)) || (a.addedAt - b.addedAt));
    while (all.length > s.shelfMax) { const x = all.shift(); letGo.push(x); shelf = shelf.filter(y => y !== x); }
    return { shelf, added: shelf.some(x => x.id === item.id), letGo };
  }
  function rank(x) { return x.source === 'saved' ? 1 : 0; }

  function shelfExpire(shelf, s, now) {
    now = now || Date.now();
    const day = 86400000;
    const keep = [], letGo = [];
    for (const x of shelf || []) {
      const ttl = (x.source === 'saved' ? s.shelfExpireDays : s.shelfAutoExpireDays) * day;
      (now - x.addedAt > ttl ? letGo : keep).push(x);
    }
    return { shelf: keep, letGo };
  }

  /** The single next thing to suggest from the shelf (saved first, then newest). */
  function shelfNext(shelf, s) {
    const items = (shelf || []).slice().filter(x => (x.load == null) || x.load <= Math.max(1, s.maxLoad));
    items.sort((a, b) => (rank(b) - rank(a)) || (b.addedAt - a.addedAt));
    return items[0] || null;
  }

  function merge(stored) {
    const out = Object.assign({}, DEFAULTS);
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(DEFAULTS)) if (stored[k] !== undefined) out[k] = stored[k];
    }
    return out;
  }

  root.MindfulPolicy = { DEFAULTS, PRESETS, NEED_LABELS, NEED_MATCH, decide, shelfAdd, shelfExpire, shelfNext, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MindfulPolicy;
})(typeof globalThis !== 'undefined' ? globalThis : this);
