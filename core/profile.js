/*
 * Mindful Feed – what each mood means *to you*.
 *
 * Built from a short setup questionnaire (and editable later):
 *
 *  calibration   what counts as easy / demanding for you: content types that
 *                stay easy when you're tired, types that are always work,
 *                what tires you (length, density, jargon, emotion, conflict)
 *                and from what length a video feels like a commitment.
 *  moodProfiles  per mood: content types that help, types to keep away,
 *                maximum length, and your own words to include / avoid.
 *  overrides     per mood setting changes that follow from your answers
 *                (mood repair vs. mood matching, how news leaves you, …).
 *
 * The questions draw on well-known ideas from emotion research: people
 * regulate mood either by *repairing* it (seeking the opposite) or by
 * *matching* it (staying with the feeling); both are valid, so we ask.
 * Cognitive effort depends on the person, so we ask what is effortless for
 * you when you're tired instead of assuming it.
 */
(function (root) {
  'use strict';

  // Sensible defaults until you answer the questionnaire.
  const DEFAULT_MOOD_PROFILES = {
    drained: { like: ['ambient', 'music', 'animals', 'cozy', 'comedy'], avoid: ['essays', 'lectures', 'news', 'podcasts'] },
    anxious: { like: ['ambient', 'animals', 'cozy', 'music'], avoid: ['news', 'essays', 'emotional'] },
    unwind: { like: [], avoid: [] },
    laugh: { like: ['comedy', 'animals', 'gaming'], avoid: ['news', 'essays', 'lectures'] },
    curious: { like: ['curiosity'], avoid: ['news', 'lectures'] },
    focused: { like: ['essays', 'lectures', 'curiosity', 'podcasts'], avoid: ['vlogs', 'comedy', 'gaming', 'music', 'ambient'] },
    creative: { like: ['making'], avoid: ['news'] },
    lowMotivation: { like: ['motivation'], avoid: ['news'] },
    sleep: { like: ['ambient', 'music', 'cozy'], avoid: ['news', 'essays', 'lectures', 'gaming', 'sports'] },
  };

  const DEFAULT_CALIBRATION = { easy: [], hard: [], strain: [], lengthMin: null };

  const STRAIN = {
    long: 'Long videos',
    dense: 'Lots of facts, numbers or information',
    technical: 'Technical language or jargon',
    fast: 'Fast talking or hectic editing',
    emotional: 'Emotional topics',
    conflict: 'Arguing, drama or conflict',
  };

  // Moods considered "low" for the mood repair vs. matching question.
  const LOW_MOODS = ['drained', 'anxious', 'sleep', 'lowMotivation'];

  /**
   * The questionnaire, as data. `type`: multi (chips), single (cards),
   * words (two text fields). Per-mood questions use {mood} in the text.
   */
  const GENERAL_QUESTIONS = [
    {
      id: 'easy', type: 'multi', options: 'types',
      q: 'Think of an evening when you\'re worn out. Which of these could you still watch without effort?',
      help: 'What feels effortless differs a lot between people – this tells Mindful Feed what "easy" means for you.',
    },
    {
      id: 'hard', type: 'multi', options: 'types',
      q: 'Which of these feel like real mental work – even on a good day?',
      help: 'These will be treated as "demanding", so they stay out of moods where you have little energy.',
    },
    {
      id: 'strain', type: 'multi', options: 'strain',
      q: 'What makes a video tiring for you?',
      help: 'Videos with these traits are rated one step more demanding for you.',
    },
    {
      id: 'lengthMin', type: 'single',
      q: 'From what length does a video start to feel like a commitment?',
      options: [[10, 'About 10 minutes'], [20, 'About 20 minutes'], [40, 'About 40 minutes'], [0, 'Length doesn\'t matter to me']],
    },
    {
      id: 'lowPref', type: 'single',
      q: 'When you\'re feeling low, what usually helps you more?',
      help: 'Psychologists call these mood repair and mood matching. Both are healthy – people just differ.',
      options: [['lift', 'Something that lifts me – light, cheerful, warm'], ['match', 'Something that meets me where I am – sad songs, quiet stories'], ['depends', 'It really depends on the day']],
    },
    {
      id: 'newsFeel', type: 'single',
      q: 'After watching political videos or news, you usually feel…',
      options: [['fine', 'Informed, and fine'], ['tense', 'Tense, worried or drained'], ['depends', 'It depends on my day']],
    },
    {
      id: 'companyFeel', type: 'single',
      q: 'Some creators feel like a friend keeping you company. After an hour with them, you usually feel…',
      help: 'This decides whether vlogs and "hang out" streams are allowed in your calm moods.',
      options: [['comfort', 'Comforted and recharged'], ['empty', 'A bit empty, or like I avoided something'], ['none', 'I don\'t really watch those']],
    },
    { id: 'moods', type: 'multi', options: 'moods', q: 'Which moods do you want to set up now?', help: 'You can redo this any time.' },
  ];

  const MOOD_QUESTIONS = [
    { id: 'like', type: 'multi', options: 'types', q: 'When you feel {mood}, what actually helps you?', help: 'Think of the last time – what did you watch that left you better off afterwards?' },
    { id: 'avoid', type: 'multi', options: 'types', q: '…and what makes it worse when you feel {mood}?' },
    { id: 'maxMinutes', type: 'single', q: 'How long may videos be when you feel {mood}?', options: [[10, 'Up to 10 minutes'], [20, 'Up to 20 minutes'], [45, 'Up to 45 minutes'], [0, 'Any length']] },
    { id: 'words', type: 'words', q: 'Anything specific that\'s perfect for {mood} – or that should stay away?', help: 'Optional. Words or channel names, separated by commas.' },
  ];

  function uniq(a) { return Array.from(new Set((a || []).filter(Boolean))); }
  function words(s) { return uniq(String(s || '').split(/[,\n]/).map(x => x.trim()).filter(x => x.length > 1)); }

  /** Turn questionnaire answers into calibration, mood profiles and setting overrides. */
  function build(answers) {
    const a = answers || {};
    const calibration = {
      easy: uniq(a.easy),
      hard: uniq(a.hard).filter(t => !(a.easy || []).includes(t)),
      strain: uniq(a.strain),
      lengthMin: Number(a.lengthMin) || null,
    };
    const moodProfiles = {};
    const overrides = {};
    for (const key of Object.keys(a.perMood || {})) {
      const m = a.perMood[key] || {};
      moodProfiles[key] = {
        like: uniq(m.like),
        avoid: uniq(m.avoid).filter(t => !(m.like || []).includes(t)),
        maxMinutes: Number(m.maxMinutes) || null,
        likeWords: words(m.likeWords),
        avoidWords: words(m.avoidWords),
      };
    }
    const moods = uniq(a.moods);
    for (const key of moods) {
      const o = overrides[key] = {};
      const low = LOW_MOODS.includes(key);
      if (low && a.lowPref === 'match') o.emotional = 'show';
      if (low && a.lowPref === 'lift') o.emotional = 'hide';
      if (a.newsFeel === 'fine' && (key === 'curious' || key === 'unwind')) { o.politics = 'show'; o.news = 'show'; }
      if (a.newsFeel === 'tense' && key !== 'focused') { o.politics = 'hide'; o.news = 'hide'; }
      if (a.companyFeel === 'comfort' && (key === 'anxious' || key === 'unwind' || key === 'drained')) o.blockParasocial = false;
      if (a.companyFeel === 'empty') o.blockParasocial = true;
      if (!Object.keys(o).length) delete overrides[key];
    }
    if (a.companyFeel === 'comfort') {
      for (const key of ['anxious', 'unwind', 'drained']) {
        if (moodProfiles[key] && !moodProfiles[key].avoid.includes('vlogs')) moodProfiles[key].like = uniq(moodProfiles[key].like.concat(['vlogs']));
      }
    }
    return { answers: a, calibration, moodProfiles, overrides, at: Date.now() };
  }

  /** Re-rate a video's difficulty with your personal calibration. */
  function personalize(prof, meta, cal, titleComplexity) {
    if (!cal || (!cal.easy.length && !cal.hard.length && !cal.strain.length && !cal.lengthMin)) return prof;
    const p = Object.assign({}, prof, { reasons: (prof.reasons || []).slice() });
    const types = p.types || [];
    const background = types.includes('ambient') || types.includes('music');
    const hard = types.find(t => cal.hard.includes(t));
    if (hard) { p.load = 2; p.reasons.unshift('demanding for you: ' + hard); }
    else if (types.length && types.every(t => cal.easy.includes(t))) { p.load = 0; p.reasons.unshift('easy for you: ' + types.join(', ')); }
    let extra = 0; const why = [];
    const dur = p.durationSec;
    const longAt = (cal.lengthMin || (cal.strain.includes('long') ? 20 : 0)) * 60;
    if (longAt && dur != null && dur > longAt && !background) { extra++; why.push('long'); }
    if (cal.strain.includes('dense') && p.informational && (dur == null || dur > 8 * 60)) { extra++; why.push('information-dense'); }
    if (cal.strain.includes('technical') && titleComplexity && titleComplexity(meta.title) >= 1) { extra++; why.push('technical'); }
    if (cal.strain.includes('emotional') && p.emotional) { extra++; why.push('emotional'); }
    if (cal.strain.includes('conflict') && (p.political || p.addictive >= 2 || p.parasocial >= 2)) { extra++; why.push('conflict / drama'); }
    if (cal.strain.includes('fast') && (p.addictive >= 2 || types.includes('gaming') || types.includes('vlogs'))) { extra++; why.push('fast-paced'); }
    if (extra && !hard) {
      p.load = Math.min(2, p.load + (extra >= 2 ? 2 : 1));
      p.reasons.unshift('tiring for you: ' + why.join(', '));
    }
    if (p.load > 0 || types.length) p.known = true;
    return p;
  }

  /** The profile that applies to a mood: your answers → the mood's own → defaults. */
  function moodProfileFor(profile, moodKey, mood) {
    if (profile && profile.moodProfiles && profile.moodProfiles[moodKey]) return profile.moodProfiles[moodKey];
    if (mood && mood.profile) return mood.profile;
    return DEFAULT_MOOD_PROFILES[moodKey] || null;
  }

  root.MindfulProfile = {
    DEFAULT_MOOD_PROFILES, DEFAULT_CALIBRATION, STRAIN, LOW_MOODS, GENERAL_QUESTIONS, MOOD_QUESTIONS,
    build, personalize, moodProfileFor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MindfulProfile;
})(typeof globalThis !== 'undefined' ? globalThis : this);
