/*
 * Mindful Feed – heuristic video classifier.
 *
 * Turns the little we know about a video (title, channel, duration, a snippet
 * of description, whether it is a Short / live) into a "psychological profile":
 *
 *   needs        which needs it can serve: relax, laugh, curious, learn,
 *                create, inspire, comfort
 *   load         cognitive load 0 = relaxed, 1 = in-between, 2 = strenuous
 *   tone         'light' | 'neutral' | 'heavy'
 *   political    true if it is about politics / culture war / geopolitics
 *   news         true if it is news / current events
 *   distressing  crime, war, disasters, horror …
 *   parasocial   score (0..n) – vlogs, drama, reactions, "we need to talk" …
 *   addictive    score (0..n) – Shorts, clickbait, rage bait, challenges …
 *   informational  true if the main value of the video is information
 *   topics       coarse topic tags
 *   reasons      human-readable explanation (shown in the filter log)
 *
 * Runs everywhere (browser, Android WebView, Node for tests) and has no deps.
 * It is deliberately transparent: every decision can be traced to a keyword.
 * An optional AI pass (see android/ AiClassifier) can override these labels.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Lexicons. Entries are matched case-insensitively on word boundaries
  // (a trailing '*' means prefix match, e.g. 'politic*' matches 'politics').
  // English + German, because both are common for our users. Extend freely.
  // ---------------------------------------------------------------------------
  const LEX = {
    political: [
      'politic*', 'election*', 'vote', 'voting', 'voters', 'senate', 'senator*', 'congress*',
      'parliament*', 'bundestag', 'government*', 'president*', 'prime minister', 'chancellor',
      'democrat*', 'republican*', 'gop', 'maga', 'liberals', 'conservatives', 'left-wing',
      'right-wing', 'far-right', 'far-left', 'leftist*', 'woke', 'anti-woke', 'trump', 'biden',
      'kamala', 'harris', 'vance', 'obama', 'putin', 'zelensky*', 'netanyahu', 'merz', 'scholz',
      'afd', 'cdu', 'csu', 'spd', 'fdp', 'bsw', 'die linke', 'labour', 'tory', 'tories', 'brexit',
      'immigration', 'migrants', 'migration', 'refugees', 'abortion', 'gun control', 'nato',
      'ukraine', 'russia', 'gaza', 'israel*', 'palestin*', 'hamas', 'hezbollah', 'iran',
      'tariff*', 'sanctions', 'geopolitic*', 'culture war', 'supreme court', 'lawmakers',
      'legislation', 'propaganda', 'socialis*', 'communis*', 'fascis*', 'ideolog*', 'regierung',
      'wahl*', 'partei*', 'politik*', 'kanzler*', 'minister*', 'protest*', 'dictator*',
      'white house', 'kremlin', 'eu commission', 'campaign trail', 'debate night',
    ],
    news: [
      'breaking', 'news', 'headlines', 'live updates', 'latest updates', 'this week in',
      'press conference', 'nachrichten', 'tagesschau', 'tagesthemen', 'heute journal',
      'just announced', 'developing story', 'news roundup',
    ],
    distressing: [
      'murder*', 'murdered', 'killed', 'killing', 'killer*', 'death', 'dead', 'dies', 'died',
      'shooting', 'shot dead', 'war', 'wars', 'warfare', 'attack*', 'bomb*', 'terror*',
      'plane crash', 'car crash', 'crashed', 'disaster*', 'tragedy', 'tragic', 'abuse*', 'assault*', 'kidnap*', 'missing',
      'true crime', 'serial killer', 'crime*', 'horror', 'scary', 'creepy', 'haunted',
      'collapse*', 'crisis', 'apocalyp*', 'doomsday', 'doomed', 'recession', 'layoffs', 'suicide',
      'genocide', 'massacre', 'execution', 'cult leader', 'disturbing', 'graphic content', 'dark side',
      'nightmare', 'catastroph*', 'mord*', 'krieg*', 'unfall', 'katastrophe*', 'tot', 'tote',
      'pandemic', 'outbreak', 'famine', 'torture*',
    ],
    parasocial: [
      ['vlog*', 2], ['day in my life', 2], ['day in the life', 1], ['storytime', 2],
      ['story time', 2], ['q&a', 2], ['q and a', 2], ['answering your questions', 2],
      ['get ready with me', 2], ['grwm', 2], ['come with me', 2], ['spend the day with', 2],
      ['life update', 3], ["i'm leaving", 3], ['im leaving', 3], ['quitting youtube', 3],
      ['leaving youtube', 3], ['we need to talk', 3], ['i need to talk', 3], ['we need to talk about', 1],
      ['the truth about me', 3], ['my girlfriend', 2], ['my boyfriend', 2], ['my wife', 1],
      ['my husband', 1], ['broke up', 3], ['breakup', 2], ["we're pregnant", 3],
      ['apology', 3], ['apologize', 2], ['apologizing', 2], ['drama', 2], ['exposed', 3],
      ['exposing', 3], ['responds to', 2], ['reacts to', 2], ['reaction', 2], ['reacting', 2],
      ['react', 1], ['spilling the tea', 3], ['beef', 1], ['cancelled', 1], ['canceled', 1],
      ['callout', 2], ['my honest thoughts', 2], ['morning routine', 2], ['night routine', 2],
      ['what i eat in a day', 2], ['haul', 1], ['stream highlights', 2], ['vod', 2],
      ['livestream', 1], ['just chatting', 3], ['my life', 1], ['emotional', 1],
      ['crying', 2], ['i cried', 2], ['my mental health', 1], ['personal update', 3],
      ['fans', 1], ['subscribers', 1], ['meet my', 2],
    ],
    addictive: [
      ["you won't believe", 3], ['you wont believe', 3], ['gone wrong', 3], ['not clickbait', 3],
      ['insane', 1], ['shocking', 2], ['shocked', 1], ['crazy', 1], ['unbelievable', 1],
      ['must watch', 2], ['watch till the end', 3], ['watch until the end', 3], ['wait for it', 2],
      ['last to leave', 3], ['24 hours', 2], ['challenge', 1], ['prank*', 2],
      ['try not to laugh', 2], ['fails', 1], ['ranking every', 1], ['i spent', 1],
      ['i survived', 2], ['100 days', 2], ['destroys', 3], ['destroyed', 2], ['owned', 2],
      ['humiliat*', 3], ['rage', 2], ['triggered', 2], ['meltdown', 2], ['slams', 3],
      ['eviscerat*', 3], ['goes off on', 3], ['loses it', 2], ['epic fail', 2],
      ['you need to see this', 2], ['this changes everything', 2], ['the end of', 1],
      ['nobody is talking about', 2], ['no one is talking about', 2], ['they lied', 2],
      ['secretly', 1], ['hidden truth', 2], ['what happens next', 2], ['viral', 1],
      ['giveaway', 2],
    ],
    relax: [
      'relax*', 'calm*', 'ambient', 'ambience', 'asmr', 'lofi', 'lo-fi', 'chill*', 'sleep*',
      'meditat*', 'breathing', 'yoga', 'nature sounds', 'rain sounds', 'rain', 'ocean waves',
      'waves', 'forest', 'birdsong', 'birds singing', 'fireplace', 'piano', 'cozy', 'cosy',
      'slow tv', 'slow living', 'cottage*', 'garden*', 'train ride', 'walking tour', '4k walk',
      'scenic', 'aquarium', 'bob ross', 'pottery', 'knitting', 'peaceful', 'soothing',
      'entspann*', 'gemütlich', 'study with me', 'white noise', 'brown noise', 'sounds for',
      'stargazing', 'drone footage', 'timelapse', 'time-lapse',
    ],
    laugh: [
      'funny', 'comedy', 'comedian', 'sketch', 'stand-up', 'standup', 'stand up comedy',
      'bloopers', 'parody', 'meme*', 'hilarious', 'laugh*', 'jokes', 'sitcom', 'cartoon*',
      'animation', 'animated', 'improv', 'satire', 'outtakes', 'lustig', 'witzig', 'humor',
      'humour', 'wholesome', 'cute', 'puppy', 'puppies', 'kitten*', 'funny cats', 'funny dogs',
      "let's play", 'lets play', 'gameplay', 'playthrough', 'speedrun', 'music video',
      'official video', 'official music video', 'live performance', 'concert', 'cover',
    ],
    info: [
      'explained', 'explain*', 'explainer', 'how does', 'how do', 'why do', 'why does',
      'why is', 'why are', 'what is', 'what are', 'what happens', 'what if', 'the science of',
      'science', 'history of', 'documentary', 'doku*', 'dokumentation', 'lecture', 'lesson*',
      'course', 'tutorial', 'guide', 'how to', 'learn*', 'analysis', 'analyzing', 'deep dive',
      'in depth', 'in-depth', 'essay', 'video essay', 'physics', 'math', 'maths', 'mathematics',
      'chemistry', 'biology', 'economics', 'economy', 'philosophy', 'psychology',
      'neuroscience', 'research', 'studies', 'theory', 'case study', 'the story of',
      'rise and fall', 'the truth about', 'beginner*', 'introduction to', 'intro to',
      'crash course', 'everything you need to know', 'erklärt', 'erklärung', 'warum', 'wieso',
      'wie funktioniert', 'geschichte', 'wissen', 'review', 'breakdown', 'investigat*',
      'interview', 'podcast', 'ted talk', 'tedx', 'masterclass', 'facts', 'fact',
      'secrets of', 'inside the', 'science behind', 'engineering', 'astronomy', 'space',
    ],
    deep: [
      'lecture', 'full course', 'complete course', 'masterclass', 'seminar', 'conference',
      'proof', 'theorem', 'deep dive', 'in depth', 'in-depth', 'complete guide', 'advanced',
      'university', 'stanford', 'harvard', 'phd', 'whitepaper', 'philosophy',
      'quantum', 'calculus', 'linear algebra', 'thermodynamics', 'macroeconomics',
      'documentary', 'video essay', 'analysis', 'podcast', 'interview', 'debate',
      'vorlesung', 'full documentary',
    ],
    create: [
      'recipe*', 'cooking', 'cook', 'baking', 'bake', 'diy', 'how to make', 'build*',
      'woodworking', 'craft*', 'repair*', 'fix', 'fixing', 'restoration', 'restoring',
      'workout', 'exercise', 'fitness', 'stretching', 'stretch', 'rezept*', 'kochen', 'backen',
      'drawing', 'painting', 'sewing', 'crochet', 'origami', 'tutorial', 'step by step',
      'gardening', 'home improvement', 'renovat*', 'sourdough', 'meal prep',
    ],
    inspire: [
      'motivation*', 'inspir*', 'success story', 'changed my life', 'transformation',
      'journey', 'overcom*', 'ted talk', 'tedx', 'commencement', 'speech', 'never give up',
      'dream*', 'achiev*', 'kindness', 'hope', 'hopeful', 'resilien*', 'mindset',
    ],
    comfort: [
      'wholesome', 'cozy', 'cosy', 'comfort*', 'heartwarming', 'reunion', 'kindness',
      'grandma', 'grandpa', 'family', 'friendship', 'cute', 'gentle', 'healing', 'self-care',
      'self care', 'hug', 'rescue', 'rescued', 'happy ending', 'feel good', 'feel-good',
      'good news',
    ],
  };

  // Coarse topic dictionary. Kept intentionally small and editable.
  const TOPICS = {
    science: ['science', 'physics', 'chemistry', 'biology', 'research', 'experiment*', 'quantum', 'evolution', 'wissenschaft'],
    space: ['space', 'nasa', 'esa', 'spacex', 'planet*', 'galaxy', 'galaxies', 'universe', 'astronom*', 'black hole', 'rocket*', 'moon', 'mars', 'telescope'],
    nature: ['nature', 'wildlife', 'animal*', 'ocean', 'forest', 'bird*', 'whale*', 'shark*', 'insect*', 'national park', 'tier*', 'natur'],
    pets: ['cat', 'cats', 'kitten*', 'dog', 'dogs', 'puppy', 'puppies', 'pet', 'pets', 'hamster'],
    technology: ['tech', 'technology', 'smartphone', 'iphone', 'android', 'gadget*', 'laptop', 'pc build', 'ai', 'artificial intelligence', 'robot*', 'chip*', 'apple', 'google', 'samsung'],
    programming: ['programming', 'coding', 'code', 'python', 'javascript', 'typescript', 'rust', 'java', 'kotlin', 'developer', 'software', 'algorithm*', 'linux', 'git'],
    gaming: ['gaming', 'game', 'games', 'gameplay', "let's play", 'lets play', 'playthrough', 'speedrun', 'minecraft', 'fortnite', 'nintendo', 'playstation', 'xbox', 'steam', 'zelda', 'pokemon', 'esports'],
    music: ['music', 'song', 'songs', 'album', 'cover', 'piano', 'guitar', 'concert', 'live performance', 'music video', 'lofi', 'lo-fi', 'playlist', 'band', 'remix', 'musik'],
    food: ['food', 'recipe*', 'cooking', 'cook', 'baking', 'bake', 'chef', 'restaurant', 'street food', 'meal', 'kitchen', 'rezept*', 'kochen', 'essen'],
    history: ['history', 'historical', 'ancient', 'medieval', 'empire', 'world war', 'ww2', 'wwii', 'ww1', 'roman*', 'egypt*', 'geschichte'],
    art: ['art', 'artist', 'painting', 'drawing', 'sculpt*', 'design', 'illustration', 'animation', 'pottery', 'kunst'],
    sports: ['sport*', 'football', 'soccer', 'basketball', 'nba', 'nfl', 'tennis', 'f1', 'formula 1', 'olympic*', 'bundesliga', 'champions league', 'boxing', 'ufc', 'cycling', 'climbing'],
    finance: ['finance', 'money', 'invest*', 'stock*', 'crypto*', 'bitcoin', 'economy', 'economics', 'budget*', 'income', 'tax*', 'real estate', 'geld', 'börse'],
    health: ['health', 'fitness', 'workout', 'exercise', 'nutrition', 'diet', 'sleep', 'mental health', 'yoga', 'meditation', 'gesundheit'],
    travel: ['travel*', 'trip', 'tour', 'walking tour', 'city', 'country', 'island', 'backpacking', 'road trip', 'japan', 'reise*'],
    vehicles: ['car', 'cars', 'truck*', 'motorcycle', 'engine', 'ev', 'tesla', 'porsche', 'bmw', 'train', 'trains', 'plane', 'aviation', 'auto'],
    comedy: ['comedy', 'funny', 'sketch', 'stand-up', 'standup', 'parody', 'satire', 'meme*', 'hilarious'],
    film: ['movie*', 'film*', 'trailer', 'cinema', 'netflix', 'series', 'tv show', 'episode', 'marvel', 'star wars', 'anime'],
    books: ['book*', 'novel*', 'reading', 'author', 'literature', 'buch', 'bücher'],
    philosophy: ['philosophy', 'philosopher', 'stoic*', 'stoicism', 'existential*', 'meaning of life', 'ethics', 'nietzsche', 'philosophie'],
    psychology: ['psychology', 'psychologist', 'mental health', 'anxiety', 'depression', 'adhd', 'autism', 'therapy', 'therapist', 'trauma', 'brain', 'neuroscience', 'psychologie'],
    crafts: ['diy', 'craft*', 'woodworking', 'sewing', 'knitting', 'crochet', 'origami', 'restoration', 'repair*', 'build*', 'maker'],
    languages: ['language*', 'english', 'german', 'spanish', 'japanese', 'french', 'grammar', 'vocabulary', 'learn german', 'learn english', 'sprache*'],
    fashion: ['fashion', 'outfit*', 'makeup', 'skincare', 'beauty', 'hair', 'style', 'haul'],
    home: ['home', 'house', 'apartment', 'interior', 'garden*', 'gardening', 'cleaning', 'organiz*', 'tiny house', 'renovat*', 'cottage'],
    politics: ['politic*', 'election*', 'government', 'parliament', 'president', 'trump', 'biden', 'politik'],
    news: ['news', 'breaking', 'headlines', 'nachrichten'],
  };

  const NEEDS = ['relax', 'laugh', 'curious', 'learn', 'create', 'inspire', 'comfort'];

  // ---------------------------------------------------------------------------
  // Matching helpers
  // ---------------------------------------------------------------------------
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Word characters incl. common accented letters so 'tot' doesn't hit 'total'.
  const W = 'A-Za-z0-9\\u00C0-\\u024F';

  function compile(entry) {
    let term = entry, weight = 1;
    if (Array.isArray(entry)) { term = entry[0]; weight = entry[1]; }
    term = term.toLowerCase();
    let prefix = false;
    if (term.endsWith('*')) { prefix = true; term = term.slice(0, -1); }
    const body = escapeRe(term);
    const startsWord = new RegExp('^[' + W + ']').test(term);
    const endsWord = new RegExp('[' + W + ']$').test(term);
    const src = (startsWord ? '(?:^|[^' + W + '])' : '') + body +
      (prefix || !endsWord ? '' : '(?=$|[^' + W + '])');
    return { term: entry, label: term, re: new RegExp(src, 'i'), weight };
  }

  const COMPILED = {};
  for (const k of Object.keys(LEX)) COMPILED[k] = LEX[k].filter(e => (Array.isArray(e) ? e[1] : 1) > 0).map(compile);
  const COMPILED_TOPICS = {};
  for (const k of Object.keys(TOPICS)) COMPILED_TOPICS[k] = TOPICS[k].map(compile);

  function hits(list, text) {
    const out = [];
    for (const c of list) if (c.re.test(text)) out.push(c);
    return out;
  }
  function score(list, text) {
    let s = 0; const labels = [];
    for (const h of hits(list, text)) { s += h.weight; labels.push(h.label); }
    return { score: s, labels };
  }

  function parseDuration(txt) {
    if (txt == null) return null;
    if (typeof txt === 'number') return txt;
    const m = String(txt).trim().match(/^(\d{1,3})(?::(\d{2}))?(?::(\d{2}))?$/);
    if (!m) return null;
    const parts = [m[1], m[2], m[3]].filter(x => x !== undefined).map(Number);
    let sec = 0; for (const p of parts) sec = sec * 60 + p;
    return sec;
  }

  // Clickbait-y typography: ALL CAPS words, !!!, ?!, shock emojis.
  function typographyScore(title) {
    if (!title) return { score: 0, labels: [] };
    const labels = []; let s = 0;
    const words = title.split(/\s+/).filter(w => /[A-Za-zÄÖÜ]{3,}/.test(w));
    const caps = words.filter(w => w === w.toUpperCase() && /[A-Z]/.test(w));
    if (words.length >= 3 && caps.length / words.length >= 0.5) { s += 2; labels.push('MOSTLY CAPS'); }
    else if (caps.length >= 2) { s += 1; labels.push('CAPS words'); }
    if (/!{2,}|\?!|!\?/.test(title)) { s += 1; labels.push('!!!'); }
    const shock = title.match(/[\u{1F631}\u{1F92F}\u{1F633}\u{1F62D}\u{1F525}\u{1F480}\u{1F6A8}\u{203C}\u{2757}]/gu);
    if (shock && shock.length) { s += Math.min(2, shock.length); labels.push('shock emoji'); }
    return { score: s, labels };
  }

  /**
   * @param {object} meta {id,title,channel,durationSec|durationText,isShort,isLive,description,extraText}
   * @returns {object} profile (see file header)
   */
  function classify(meta) {
    meta = meta || {};
    const title = String(meta.title || '');
    const channel = String(meta.channel || '');
    const desc = String(meta.description || '');
    const text = (title + ' \n ' + channel + ' \n ' + desc).toLowerCase();
    const titleLc = (title + ' \n ' + channel).toLowerCase();
    const dur = meta.durationSec != null ? meta.durationSec : parseDuration(meta.durationText);
    const reasons = [];

    const pol = score(COMPILED.political, titleLc);
    const news = score(COMPILED.news, titleLc);
    const dis = score(COMPILED.distressing, titleLc);
    const para = score(COMPILED.parasocial, titleLc);
    const add = score(COMPILED.addictive, titleLc);
    const typo = typographyScore(title);
    const relax = score(COMPILED.relax, text);
    const laugh = score(COMPILED.laugh, text);
    const info = score(COMPILED.info, titleLc);
    const deep = score(COMPILED.deep, text);
    const create = score(COMPILED.create, titleLc);
    const inspire = score(COMPILED.inspire, titleLc);
    const comfort = score(COMPILED.comfort, text);

    let addictive = add.score + typo.score;
    if (add.labels.length) reasons.push('clickbait: ' + add.labels.join(', '));
    if (typo.labels.length) reasons.push('typography: ' + typo.labels.join(', '));
    if (meta.isShort) { addictive += 5; reasons.push('Short'); }

    let parasocial = para.score;
    if (para.labels.length) reasons.push('parasocial: ' + para.labels.join(', '));
    // Very long streams/VODs are typically companionship content.
    if (dur != null && dur > 3 * 3600 && !relax.score) { parasocial += 1; reasons.push('very long stream'); }

    const political = pol.score >= 1;
    if (political) reasons.push('political: ' + pol.labels.slice(0, 4).join(', '));
    const isNews = news.score >= 1;
    if (isNews) reasons.push('news');
    const distressing = dis.score >= 1;
    if (distressing) reasons.push('distressing: ' + dis.labels.slice(0, 4).join(', '));

    const informational = info.score >= 1 || isNews || (political && !laugh.score);
    if (info.labels.length) reasons.push('informational: ' + info.labels.slice(0, 4).join(', '));

    // --- needs -------------------------------------------------------------
    const needs = new Set();
    if (relax.score && !distressing && !political) needs.add('relax');
    if (laugh.score && !distressing) needs.add('laugh');
    // "Funny sketch: my cat reviews my cooking" is comedy, not a recipe.
    if (create.score && !(laugh.score && !info.score)) needs.add('create');
    if (inspire.score && !distressing) needs.add('inspire');
    if (comfort.score && !distressing && !political) needs.add('comfort');

    // --- cognitive load ----------------------------------------------------
    let load = 0;
    if (informational) {
      load = 1;
      if (deep.score) load = 2;
      if (dur != null && dur >= 25 * 60) load = 2;
      if (dur != null && dur <= 8 * 60 && !deep.score) load = 1;
    }
    if (needs.has('create') && load === 0) load = 1;
    if (political || isNews || distressing) load = Math.max(load, 1);
    if (relax.score && !informational) load = 0;
    if (meta.isShort) load = Math.min(load, 1);

    if (informational) {
      if (load <= 1 && !political && !isNews) needs.add('curious');
      needs.add('learn');
    }
    if (needs.has('create')) needs.add('learn');

    // --- tone --------------------------------------------------------------
    let tone = 'neutral';
    if (distressing || political || isNews || add.labels.some(l => /rage|destroy|slams|humiliat|evisc|meltdown|goes off/.test(l))) tone = 'heavy';
    else if (needs.has('laugh') || needs.has('relax') || needs.has('comfort')) tone = 'light';

    // --- topics ------------------------------------------------------------
    const topics = [];
    for (const k of Object.keys(COMPILED_TOPICS)) {
      if (hits(COMPILED_TOPICS[k], text).length) topics.push(k);
    }
    if (political && !topics.includes('politics')) topics.push('politics');
    if (isNews && !topics.includes('news')) topics.push('news');

    const known = needs.size > 0 || informational || political || isNews || distressing ||
      parasocial > 0 || addictive > 0;

    return {
      needs: Array.from(needs),
      load,
      tone,
      political,
      news: isNews,
      distressing,
      parasocial,
      addictive,
      informational,
      topics,
      known,
      durationSec: dur,
      reasons,
      source: 'heuristic',
    };
  }

  /** Merge an AI result (partial profile) over a heuristic one. */
  function mergeAi(base, ai) {
    if (!ai) return base;
    const out = Object.assign({}, base);
    for (const k of ['needs', 'load', 'tone', 'political', 'news', 'distressing', 'informational', 'topics']) {
      if (ai[k] !== undefined && ai[k] !== null) out[k] = ai[k];
    }
    if (typeof ai.parasocial === 'boolean') out.parasocial = ai.parasocial ? Math.max(2, base.parasocial) : 0;
    if (typeof ai.addictive === 'boolean') out.addictive = ai.addictive ? Math.max(3, base.addictive) : (base.addictive >= 5 ? base.addictive : 0);
    if (ai.reason) out.reasons = ['AI: ' + ai.reason].concat(base.reasons || []);
    out.known = true;
    out.source = 'ai';
    return out;
  }

  root.MindfulClassifier = { classify, mergeAi, parseDuration, NEEDS, TOPICS: Object.keys(TOPICS), LEX };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MindfulClassifier;
})(typeof globalThis !== 'undefined' ? globalThis : this);
