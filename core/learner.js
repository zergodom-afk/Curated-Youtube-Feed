/*
 * Mindful Feed – on-device learning from your feedback (no API key needed).
 *
 * Every time you say "fits this mode" / "doesn't fit", or give a reason
 * ("too heavy", "political", "clickbait" …), the learner:
 *
 *  1. remembers the verdict for that exact video (per mode), and
 *  2. adjusts small word weights, so *similar* videos (shared title words,
 *     same channel) are treated the same way next time.
 *
 * Models are tiny dictionaries {feature: weight}. Features are title words
 * (lower-cased, stop words removed, light stemming), word pairs and the
 * channel. Everything is plain JSON so it can live in localStorage.
 *
 *   modes[need]   → does a video fit this need/mode?   (+ fits, − doesn't)
 *   dims[name]    → learned dimensions shared by all modes:
 *                   heavy, demanding, shallow, political, parasocial, clickbait
 *
 * A model's score ≥ +THRESHOLD counts as a learned "yes", ≤ −THRESHOLD as a
 * learned "no". One piece of feedback moves each of its features by ±1, so a
 * new video needs to share at least two features (e.g. two title words, or
 * one word + the channel) with past feedback before learning kicks in.
 */
(function (root) {
  'use strict';

  const THRESHOLD = 2;
  const MAX_W = 6;

  const STOP = new Set((
    'the a an and or but of in on at to for from with by is are was were be been it its this that these those ' +
    'i me my we our you your he she they them his her their what why how when where who which not no yes do does ' +
    'did done can could will would should just about into over than then so too very more most all any some ' +
    'vs ft feat official video full new part episode ep 2023 2024 2025 2026 ' +
    'der die das und oder aber von im in am an zu für mit ist sind war ein eine einer eines nicht wie was warum ' +
    'ich du er sie es wir ihr mein dein sein auf aus bei nach vor über unter auch noch nur'
  ).split(/\s+/));

  function stem(w) {
    if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }

  /** Features for one video. */
  function features(meta) {
    const title = String((meta && meta.title) || '').toLowerCase();
    const words = title.match(/[a-z0-9\u00c0-\u024f]+/g) || [];
    const kept = [];
    for (const w of words) {
      if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
      kept.push(stem(w));
    }
    const out = new Set(kept.map(w => 'w:' + w));
    for (let i = 0; i + 1 < kept.length; i++) out.add('b:' + kept[i] + '_' + kept[i + 1]);
    const ch = String((meta && meta.channel) || '').toLowerCase().trim();
    if (ch) out.add('c:' + ch);
    return Array.from(out);
  }

  function empty() {
    return { v: 1, modes: {}, dims: {}, videos: {}, examples: [], count: 0 };
  }

  function load(stored) {
    const m = empty();
    if (stored && typeof stored === 'object') {
      for (const k of ['modes', 'dims', 'videos']) if (stored[k] && typeof stored[k] === 'object') m[k] = stored[k];
      if (Array.isArray(stored.examples)) m.examples = stored.examples;
      m.count = stored.count || 0;
    }
    return m;
  }

  function bump(map, feats, delta) {
    for (const f of feats) {
      const w = (map[f] || 0) + delta * (f.startsWith('c:') ? 1.5 : 1);
      const c = Math.max(-MAX_W, Math.min(MAX_W, w));
      if (Math.abs(c) < 1e-9) delete map[f]; else map[f] = Math.round(c * 100) / 100;
    }
  }

  function score(map, feats) {
    if (!map) return 0;
    let s = 0;
    for (const f of feats) s += map[f] || 0;
    return s;
  }

  // Reasons the user can give for "doesn't fit". Each maps to a learned
  // dimension (or none = "just not this mode").
  const REASONS = {
    heavy: { label: '😣 Too heavy / dark', dim: 'heavy' },
    demanding: { label: '🧠 Too demanding', dim: 'demanding' },
    shallow: { label: '🥱 Too shallow / easy', dim: 'shallow' },
    political: { label: '🗳️ Political', dim: 'political' },
    parasocial: { label: '👤 Parasocial', dim: 'parasocial' },
    clickbait: { label: '🎣 Clickbait / addictive', dim: 'clickbait' },
    vibe: { label: '🎯 Wrong vibe for this mode', dim: null },
  };

  /**
   * Record feedback.
   * @param model  learner model (mutated)
   * @param meta   {id,title,channel}
   * @param mode   the need key the feedback is about (e.g. 'inspire')
   * @param fits   true / false
   * @param reasons array of REASONS keys (only meaningful when !fits)
   * @param modeLabel human label, stored with the example for the AI prompt
   */
  function feedback(model, meta, mode, fits, reasons, modeLabel) {
    reasons = (reasons || []).filter(r => REASONS[r]);
    const feats = features(meta);
    const prev = model.videos[meta.id] && model.videos[meta.id][mode];
    const delta = fits ? 1 : -1;
    // Undo a previous opposite verdict on the same video before applying.
    if (prev !== undefined && prev !== delta) bump(model.modes[mode] = model.modes[mode] || {}, feats, -prev);
    if (prev !== delta) bump(model.modes[mode] = model.modes[mode] || {}, feats, delta);

    const v = model.videos[meta.id] = model.videos[meta.id] || {};
    v[mode] = delta;
    v.at = Date.now();
    if (!fits && reasons.length) {
      v.reasons = Array.from(new Set((v.reasons || []).concat(reasons)));
      for (const r of reasons) {
        const dim = REASONS[r].dim;
        if (dim) bump(model.dims[dim] = model.dims[dim] || {}, feats, 1);
      }
    }
    if (fits) {
      // A video that fits a calm/light mode was evidently not "heavy"/"clickbait" for this user.
      if (['relax', 'comfort', 'laugh', 'inspire'].includes(mode)) bump(model.dims.heavy = model.dims.heavy || {}, feats, -0.5);
    }
    model.examples = model.examples.filter(e => !(e.id === meta.id && e.mode === mode));
    model.examples.push({ id: meta.id, title: meta.title || '', channel: meta.channel || '', mode, modeLabel: modeLabel || mode, fits: !!fits, reasons, at: Date.now() });
    if (model.examples.length > 200) model.examples = model.examples.slice(-200);
    model.count++;
    prune(model);
    return model;
  }

  function prune(model) {
    const ids = Object.keys(model.videos);
    if (ids.length > 3000) {
      ids.sort((a, b) => (model.videos[a].at || 0) - (model.videos[b].at || 0));
      for (const id of ids.slice(0, ids.length - 2500)) delete model.videos[id];
    }
  }

  /**
   * What the learner thinks about a video in a mode.
   * @returns {explicit: 1|-1|undefined, score:number, verdict:'yes'|'no'|null, dims:{heavy:bool,…}, reasons:[]}
   */
  function judge(model, meta, mode) {
    const feats = features(meta);
    const v = model.videos[meta.id] || {};
    const explicit = v[mode];
    const s = score(model.modes[mode], feats);
    let verdict = null;
    if (explicit === 1) verdict = 'yes';
    else if (explicit === -1) verdict = 'no';
    else if (s >= THRESHOLD) verdict = 'yes';
    else if (s <= -THRESHOLD) verdict = 'no';
    const dims = {};
    for (const name of Object.keys(model.dims)) {
      dims[name] = score(model.dims[name], feats) >= THRESHOLD || (v.reasons || []).some(r => REASONS[r] && REASONS[r].dim === name);
    }
    for (const r of v.reasons || []) if (REASONS[r] && REASONS[r].dim) dims[REASONS[r].dim] = true;
    return { explicit, score: s, verdict, dims, reasons: v.reasons || [] };
  }

  /** Apply learned dimensions to a classifier profile (returns a new profile). */
  function adjustProfile(profile, j) {
    if (!j || !j.dims) return profile;
    const p = Object.assign({}, profile, { reasons: (profile.reasons || []).slice() });
    const d = j.dims;
    if (d.heavy) { p.tone = 'heavy'; p.needs = (p.needs || []).filter(n => !['relax', 'comfort', 'laugh', 'inspire'].includes(n)); p.reasons.unshift('learned: heavy for you'); }
    if (d.demanding) { p.load = Math.min(2, p.load + 1); p.reasons.unshift('learned: demanding for you'); }
    if (d.shallow) { p.load = Math.max(0, p.load - 1); p.reasons.unshift('learned: shallow for you'); }
    if (d.political) { p.political = true; p.reasons.unshift('learned: political'); }
    if (d.parasocial) { p.parasocial = Math.max(p.parasocial || 0, 3); p.reasons.unshift('learned: parasocial'); }
    if (d.clickbait) { p.addictive = Math.max(p.addictive || 0, 4); p.reasons.unshift('learned: clickbait'); }
    if (d.heavy || d.demanding || d.shallow || d.political || d.parasocial || d.clickbait) p.known = true;
    return p;
  }

  /** Strongest learned features of a model, for the "what I've learned" view. */
  function top(map, n) {
    return Object.entries(map || {})
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, n || 8)
      .map(([f, w]) => ({ feature: f.replace(/^w:/, '').replace(/^b:/, '').replace(/_/g, ' ').replace(/^c:/, 'channel: '), weight: w }));
  }

  /** Recent examples for the optional AI prompt. */
  function examplesForAi(model, n) {
    return model.examples.slice(-(n || 40)).map(e => ({ title: e.title, channel: e.channel, mode: e.modeLabel, fits: e.fits, reasons: e.reasons.map(r => REASONS[r] ? REASONS[r].label.replace(/^\S+\s/, '') : r) }));
  }

  root.MindfulLearner = { features, empty, load, feedback, judge, adjustProfile, top, examplesForAi, REASONS, THRESHOLD };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MindfulLearner;
})(typeof globalThis !== 'undefined' ? globalThis : this);
