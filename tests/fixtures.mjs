// Synthetic YouTube responses that mirror the real renderer shapes
// (videoRenderer, videoWithContextRenderer, lockupViewModel, Shorts shelves,
// watch-next results, player responses). Used by unit and e2e tests.

const runs = t => ({ runs: [{ text: t }] });
const simple = t => ({ simpleText: t });

export function videoRenderer(id, title, channel, length) {
  return {
    videoId: id,
    title: runs(title),
    shortBylineText: runs(channel),
    lengthText: simple(length),
    navigationEndpoint: { watchEndpoint: { videoId: id } },
    trackingParams: 'abc',
  };
}
export function vwc(id, title, channel, length) {
  return {
    videoWithContextRenderer: {
      videoId: id, headline: runs(title), shortBylineText: runs(channel), lengthText: simple(length),
    },
  };
}
export function lockup(id, title, channel, length) {
  return {
    lockupViewModel: {
      contentId: id,
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      contentImage: { thumbnailViewModel: { overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: length } }] } }] } },
      metadata: {
        lockupMetadataViewModel: {
          title: { content: title },
          metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: channel } }] }, { metadataParts: [{ text: { content: '1.2M views' } }] }] } },
        },
      },
    },
  };
}
const rich = content => ({ richItemRenderer: { content } });

export const HOME_ITEMS = [
  ['vid_relax01', '3 Hours of Gentle Rain Sounds for Deep Sleep', 'Calm Place', '3:00:00'],
  ['vid_polit01', 'Senator DESTROYS reporter in INSANE exchange!!!', 'Politics Now', '8:12'],
  ['vid_para001', 'We need to talk… (life update)', 'Vlogger Jane', '22:10'],
  ['vid_info001', 'Why do cats purr? Explained', 'Science Bits', '6:12'],
  ['vid_lect001', 'Lecture 1: Introduction to Linear Algebra', 'Open University', '1:12:40'],
  ['vid_laugh01', 'Funny sketch: my cat reviews my cooking', 'Sketch Club', '4:30'],
  ['vid_crime01', 'The unsolved murder that shocked a small town', 'Dark Files', '45:00'],
  ['vid_garden1', 'Cozy cottage garden tour in spring', 'Slow Living', '18:20'],
];

export function homeBrowse() {
  const items = HOME_ITEMS.map(([id, t, c, l], i) => {
    if (i % 3 === 0) return rich({ videoRenderer: videoRenderer(id, t, c, l) });
    if (i % 3 === 1) return rich(lockup(id, t, c, l));
    return rich(vwc(id, t, c, l));
  });
  items.splice(3, 0, { richSectionRenderer: { content: { reelShelfRenderer: { items: [{ reelItemRenderer: { videoId: 'short000001', headline: simple('funny dog') } }] } } } });
  items.splice(5, 0, { richItemRenderer: { content: { adSlotRenderer: { adSlotMetadata: {} } } } });
  items.push({ richSectionRenderer: { content: { richShelfRenderer: { isShorts: true, contents: [rich({ shortsLockupViewModel: { entityId: 'shorts-shelf-item-short000002', overlayMetadata: { primaryText: { content: 'wait for it' } } } })] } } } });
  items.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'NEXT' } } } });
  return {
    responseContext: {},
    contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: items } } } }] } },
  };
}

export function watchNext(currentId) {
  return {
    contents: {
      singleColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { slimVideoMetadataSectionRenderer: { contents: [{ slimVideoInformationRenderer: { title: runs('The video you chose') } }] } },
              { itemSectionRenderer: { sectionIdentifier: 'comment-item-section', contents: [{ continuationItemRenderer: { continuationEndpoint: { token: 'COMMENTS' } } }] } },
              {
                itemSectionRenderer: {
                  sectionIdentifier: 'related-items',
                  contents: [
                    vwc('rel_000001', 'Related thing 1', 'Somebody', '10:00'),
                    vwc('rel_000002', 'Related thing 2', 'Somebody', '11:00'),
                    { reelShelfRenderer: { items: [] } },
                    { continuationItemRenderer: { continuationEndpoint: { token: 'MORE_RELATED' } } },
                  ],
                },
              },
            ],
          },
        },
        playlist: { playlist: { contents: [{ playlistPanelVideoRenderer: { videoId: 'pl_item_001', title: simple('Playlist item') } }, { playlistPanelVideoRenderer: { videoId: currentId, title: simple('current') } }] } },
        autoplay: { autoplay: { sets: [{ autoplayVideo: { watchEndpoint: { videoId: 'rel_000001' } } }] } },
      },
    },
    playerOverlays: { playerOverlayRenderer: { endScreen: { watchNextEndScreenRenderer: {} }, autoplay: {} } },
  };
}

export function playerResponse(id) {
  return { videoDetails: { videoId: id, title: 'x' }, endscreen: { endscreenRenderer: {} }, cards: { cardCollectionRenderer: {} }, adPlacements: [{}] };
}
