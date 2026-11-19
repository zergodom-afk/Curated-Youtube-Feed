// Bundles core/*.js into:
//   dist/mindful-feed.js        – plain script (what the Android app injects)
//   dist/mindful-feed.user.js   – userscript for Firefox/Kiwi + Tampermonkey/Violentmonkey
// Usage: node scripts/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ORDER = ['classifier.js', 'extractor.js', 'policy.js', 'learner.js', 'curator.js'];

export function bundle() {
  return ORDER.map(f => `// ---- core/${f} ----\n` + readFileSync(join(root, 'core', f), 'utf8')).join('\n;\n');
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const header = `// ==UserScript==
// @name         Mindful Feed for YouTube
// @namespace    https://github.com/zergodom-afk/Curated-Youtube-Feed
// @version      ${pkg.version}
// @description  Filters YouTube's own recommendations by your current mental state: needs, cognitive load, tone, politics, parasocial & addictive patterns. Removes recommendations under videos.
// @match        https://m.youtube.com/*
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = bundle();
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'mindful-feed.js'), out);
  writeFileSync(join(root, 'dist', 'mindful-feed.user.js'), header + '\n' + out);
  console.log('wrote dist/mindful-feed.js and dist/mindful-feed.user.js');
}
