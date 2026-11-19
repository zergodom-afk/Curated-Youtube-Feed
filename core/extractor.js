/*
 * Mindful Feed – YouTube response extractor / pruner.
 *
 * YouTube's web clients (m.youtube.com and www.youtube.com) receive the feed
 * as JSON: embedded in the page as `ytInitialData` and fetched afterwards
 * from /youtubei/v1/{browse,next,search,player,reel}. This module walks that
 * JSON, recognises video items in their many renderer shapes, extracts the
 * metadata we need, and removes the items our policy rejects *before* the
 * page renders them. The rest of the response is left untouched, so YouTube
 * still decides *what* you would have seen – we only decide what reaches you.
 *
 * The walker is shape-agnostic on purpose: renderer names change often, so we
 * look for known item keys anywhere in the tree instead of fixed paths.
 */
(function (root) {
  'use strict';

  // Renderers that represent a single recommendable video (or mix).
  const ITEM_KEYS = [
    'videoRenderer', 'compactVideoRenderer', 'gridVideoRenderer', 'videoWithContextRenderer',
    'reelItemRenderer', 'shortsLockupViewModel', 'lockupViewModel', 'endScreenVideoRenderer',
    'compactRadioRenderer', 'radioRenderer', 'compactMovieRenderer', 'videoCardRenderer',
  ];
  // Renderers that are explicitly chosen by the user and must never be pruned.
  const PROTECTED_KEYS = new Set([
    'playlistPanelVideoRenderer', 'playlistVideoRenderer', 'playlistVideoListRenderer',
    'playlistPanelRenderer', 'playlist',
  ]);
  // Containers that only hold Shorts.
  const SHORTS_SHELF_KEYS = ['reelShelfRenderer'];
  // Containers that only exist to recommend more stuff on the watch page.
  const WATCH_SHELF_KEYS = [
    'reelShelfRenderer', 'shelfRenderer', 'richShelfRenderer', 'horizontalCardListRenderer',
    'compactAutoplayRenderer', 'continuationItemRenderer', 'chipCloudRenderer',
    'feedFilterChipBarRenderer', 'relatedChipCloudRenderer', 'merchandiseShelfRenderer',
  ];
  // Community posts (text/image posts, polls, shared posts) in all known shapes.
  const POST_KEY_RE = /^(backstagePost(Thread)?Renderer|post(Thread)?Renderer|sharedPostRenderer|postViewModel|postMultiImageRenderer|backstageImageRenderer|pollRenderer)$/;
  function isPostElement(el) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
    let o = el;
    if (o.richItemRenderer && o.richItemRenderer.content) o = o.richItemRenderer.content;
    if (o.richSectionRenderer && o.richSectionRenderer.content) o = o.richSectionRenderer.content;
    for (const k of Object.keys(o)) {
      if (POST_KEY_RE.test(k)) return true;
      if (k === 'lockupViewModel' && /POST/.test(String(o[k] && o[k].contentType))) return true;
    }
    // A shelf / section whose items are all posts ("Latest YouTube posts").
    const shelf = o.richShelfRenderer || o.shelfRenderer || o.itemSectionRenderer || o.horizontalListRenderer;
    if (shelf) {
      const list = shelf.contents || shelf.items || (shelf.content && (shelf.content.horizontalListRenderer || {}).items) || [];
      if (Array.isArray(list) && list.length && list.every(isPostElement)) return true;
    }
    return false;
  }

  const AD_KEYS = ['adSlotRenderer', 'promotedVideoRenderer', 'compactPromotedVideoRenderer', 'promotedSparklesWebRenderer', 'statementBannerRenderer', 'bannerPromoRenderer'];

  const SKIP_TEXT_KEYS = new Set([
    'url', 'trackingParams', 'clickTrackingParams', 'params', 'token', 'webPageType',
    'rootVe', 'apiUrl', 'iconType', 'style', 'sources', 'thumbnail', 'thumbnails', 'image',
    'videoId', 'contentId', 'loggingDirectives', 'accessibilityContext', 'serializedShareEntity',
    'command', 'commandMetadata', 'visibility', 'targetId', 'key', 'id',
  ]);

  function text(x) {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    if (typeof x.simpleText === 'string') return x.simpleText;
    if (Array.isArray(x.runs)) return x.runs.map(r => r.text || '').join('');
    if (typeof x.content === 'string') return x.content;
    if (x.accessibility && x.accessibility.accessibilityData) return x.accessibility.accessibilityData.label || '';
    return '';
  }

  function firstDeep(obj, pred, depth) {
    if (depth < 0 || obj == null || typeof obj !== 'object') return undefined;
    if (Array.isArray(obj)) {
      for (const v of obj) { const r = firstDeep(v, pred, depth - 1); if (r !== undefined) return r; }
      return undefined;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const r = pred(k, v);
      if (r !== undefined) return r;
    }
    for (const k of Object.keys(obj)) {
      const r = firstDeep(obj[k], pred, depth - 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  function collectStrings(obj, out, depth) {
    if (out.length > 60 || depth < 0 || obj == null) return out;
    if (typeof obj === 'string') { if (obj.length > 1 && obj.length < 300) out.push(obj); return out; }
    if (typeof obj !== 'object') return out;
    if (Array.isArray(obj)) { for (const v of obj) collectStrings(v, out, depth - 1); return out; }
    for (const k of Object.keys(obj)) {
      if (SKIP_TEXT_KEYS.has(k)) continue;
      collectStrings(obj[k], out, depth - 1);
    }
    return out;
  }

  const DURATION_RE = /^\d{1,3}:\d{2}(?::\d{2})?$/;

  /** Extract normalized metadata from a renderer of type `key`. */
  function extractMeta(key, r) {
    const meta = { renderer: key, id: null, title: '', channel: '', durationText: null, isShort: false, isLive: false, kind: 'video' };

    meta.id = r.videoId || null;
    if (!meta.id && key === 'lockupViewModel') {
      meta.id = r.contentId || null;
      const ct = String(r.contentType || '');
      if (/PLAYLIST|PODCAST|ALBUM/.test(ct)) meta.kind = 'playlist';
    }
    if (!meta.id && key === 'shortsLockupViewModel') {
      meta.id = firstDeep(r, (k, v) => (k === 'videoId' && typeof v === 'string' ? v : undefined), 8) || null;
      if (!meta.id && typeof r.entityId === 'string') meta.id = r.entityId.replace(/^shorts-shelf-item-/, '');
    }
    if (!meta.id) meta.id = firstDeep(r, (k, v) => (k === 'videoId' && typeof v === 'string' ? v : undefined), 6) || null;
    if (/Radio/.test(key)) { meta.kind = 'mix'; meta.id = meta.id || r.playlistId || null; }

    // Title
    meta.title = text(r.title) || text(r.headline) ||
      (r.metadata && r.metadata.lockupMetadataViewModel && text(r.metadata.lockupMetadataViewModel.title)) ||
      (r.overlayMetadata && text(r.overlayMetadata.primaryText)) || '';
    if (!meta.title && r.accessibilityText) meta.title = String(r.accessibilityText);

    // Channel
    meta.channel = text(r.shortBylineText) || text(r.longBylineText) || text(r.ownerText) || '';
    if (!meta.channel && r.metadata && r.metadata.lockupMetadataViewModel) {
      const rows = (((r.metadata.lockupMetadataViewModel.metadata || {}).contentMetadataViewModel || {}).metadataRows) || [];
      const first = rows[0] && rows[0].metadataParts && rows[0].metadataParts[0];
      if (first) meta.channel = text(first.text);
    }

    // Duration / live / shorts
    meta.durationText = text(r.lengthText) || null;
    if (!meta.durationText) {
      meta.durationText = firstDeep(r, (k, v) => {
        if ((k === 'text' || k === 'simpleText' || k === 'content') && typeof v === 'string' && DURATION_RE.test(v.trim())) return v.trim();
        return undefined;
      }, 12) || null;
    }
    const blob = JSON.stringify(r);
    if (key === 'reelItemRenderer' || key === 'shortsLockupViewModel' || /reelWatchEndpoint|"\/shorts\/|"SHORTS"/.test(blob)) meta.isShort = true;
    if (/"LIVE"|BADGE_STYLE_TYPE_LIVE_NOW|"LIVE NOW"|THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE/.test(blob)) meta.isLive = true;
    meta.isAd = AD_KEYS.includes(key);

    if (/#shorts?\b/i.test(meta.title)) meta.isShort = true;
    const strings = collectStrings(r, [], 14);
    const seen = new Set([meta.title, meta.channel]);
    meta.description = strings.filter(s => !seen.has(s) && !DURATION_RE.test(s)).slice(0, 12).join(' · ');
    if (!meta.title) meta.title = strings[0] || '';
    return meta;
  }

  /** If `el` is (or wraps) a video item, return {key, data}. */
  function unwrapItem(el) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return null;
    let o = el;
    if (o.richItemRenderer && o.richItemRenderer.content) o = o.richItemRenderer.content;
    if (o.shortsLockupViewModelV2) return { key: 'shortsLockupViewModel', data: o.shortsLockupViewModelV2 };
    for (const k of ITEM_KEYS) if (o[k] && typeof o[k] === 'object') return { key: k, data: o[k] };
    return null;
  }

  function shelfKey(el, keys) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return null;
    let o = el;
    if (o.richSectionRenderer && o.richSectionRenderer.content) o = o.richSectionRenderer.content;
    if (o.itemSectionRenderer && Array.isArray(o.itemSectionRenderer.contents) && o.itemSectionRenderer.contents.length === 1) {
      const inner = o.itemSectionRenderer.contents[0];
      for (const k of keys) if (inner && inner[k]) return k;
    }
    for (const k of keys) if (o[k]) return k;
    if (o.richShelfRenderer && (o.richShelfRenderer.isShorts || /shortsLockupViewModel|reelItemRenderer/.test(JSON.stringify(o.richShelfRenderer).slice(0, 4000)))) return 'richShelfRenderer(shorts)';
    return null;
  }

  /**
   * Walk `data` and remove items.
   * @param data parsed JSON (mutated in place)
   * @param opts {
   *   decide(meta) -> {remove:boolean, reason?:string}
   *   onItem(meta, verdict)   optional observer
   *   watchPage: boolean      remove ALL recommendations (keeps playlists)
   *   currentVideoId: string
   *   hideShorts: boolean, hideAds: boolean, hidePosts: boolean
   * }
   * @returns stats {seen, removed}
   */
  function prune(data, opts) {
    const stats = { seen: 0, removed: 0, shelvesRemoved: 0, postsRemoved: 0 };
    if (!data || typeof data !== 'object') return stats;

    function visit(node, depth, protectedCtx) {
      if (depth > 60 || node == null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        let removedHere = 0;
        for (let i = node.length - 1; i >= 0; i--) {
          const el = node[i];
          if (!protectedCtx && shouldDropElement(el)) { node.splice(i, 1); removedHere++; continue; }
          visit(el, depth + 1, protectedCtx);
        }
        // On the watch page a list that only held recommendations keeps a
        // "load more" continuation; drop it so the page doesn't keep fetching
        // (and we don't keep stripping) more recommendations. Comment lists
        // never contain video items, so their continuations survive.
        if (opts.watchPage && removedHere > 0 && node.length > 0 &&
            node.every(el => el && typeof el === 'object' && el.continuationItemRenderer)) {
          node.length = 0;
        }
        return;
      }
      for (const k of Object.keys(node)) {
        visit(node[k], depth + 1, protectedCtx || PROTECTED_KEYS.has(k));
      }
    }

    function shouldDropElement(el) {
      if (!el || typeof el !== 'object') return false;
      if (opts.hidePosts && isPostElement(el)) { stats.postsRemoved++; return true; }
      if (opts.hideAds && AD_KEYS.some(k => el[k] || (el.richItemRenderer && el.richItemRenderer.content && el.richItemRenderer.content[k]))) {
        stats.removed++; return true;
      }
      if (opts.watchPage) {
        const sk = shelfKey(el, WATCH_SHELF_KEYS);
        if (sk && sk !== 'continuationItemRenderer') { stats.shelvesRemoved++; return true; }
      } else if (opts.hideShorts) {
        const sk = shelfKey(el, SHORTS_SHELF_KEYS);
        if (sk) { stats.shelvesRemoved++; return true; }
      }
      const item = unwrapItem(el);
      if (!item) return false;
      const meta = extractMeta(item.key, item.data);
      stats.seen++;
      let verdict;
      if (opts.watchPage && meta.id !== opts.currentVideoId) verdict = { remove: true, reason: 'recommendation on watch page' };
      else verdict = opts.decide ? (opts.decide(meta) || { remove: false }) : { remove: false };
      if (opts.onItem) { try { opts.onItem(meta, verdict); } catch (e) { /* observer errors must not break the page */ } }
      if (verdict.remove) { stats.removed++; return true; }
      return false;
    }

    visit(data, 0, false);
    return stats;
  }

  /**
   * Remove end screens / info cards from a player response. (Player ads are
   * deliberately left alone: stripping them trips YouTube's ad-block checks.)
   */
  function prunePlayer(pr, opts) {
    if (!pr || typeof pr !== 'object') return pr;
    opts = opts || {};
    if (opts.hideEndscreens !== false) { delete pr.endscreen; delete pr.cards; }
    return pr;
  }

  /** Remove the autoplay "up next" pointer from a watch-next response. */
  function pruneAutoplay(next) {
    if (!next || typeof next !== 'object') return;
    const c = next.contents || {};
    for (const k of ['singleColumnWatchNextResults', 'twoColumnWatchNextResults']) {
      if (c[k] && c[k].autoplay) delete c[k].autoplay;
    }
    if (next.playerOverlays && next.playerOverlays.playerOverlayRenderer) {
      const po = next.playerOverlays.playerOverlayRenderer;
      delete po.endScreen; delete po.autoplay; delete po.autonavToggle;
    }
  }

  function isWatchNext(data) {
    return !!(data && data.contents && (data.contents.singleColumnWatchNextResults || data.contents.twoColumnWatchNextResults));
  }

  root.MindfulExtractor = { prune, prunePlayer, pruneAutoplay, extractMeta, unwrapItem, isWatchNext, isPostElement, text, ITEM_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MindfulExtractor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
