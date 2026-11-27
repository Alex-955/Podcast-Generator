'use strict';

const DESKTOP_ORIGIN = 'aimiaoting://app';

function classify(raw, origin = DESKTOP_ORIGIN) {
  try {
    const url = new URL(raw);
    const allowed = new URL(origin);
    if (url.username || url.password) return 'deny';
    if (['aimiaoting:', 'https:', 'http:'].includes(url.protocol) &&
        url.protocol === allowed.protocol && url.host === allowed.host) return 'local';
    return ['http:', 'https:'].includes(url.protocol) ? 'external' : 'deny';
  } catch { return 'deny'; }
}

function guardNavigation(contents, origin, openExternal) {
  function openWeb(url) {
    if (classify(url, origin) === 'external') Promise.resolve(openExternal(url)).catch(() => {});
  }
  contents.setWindowOpenHandler(({ url }) => {
    openWeb(url);
    return { action: 'deny' };
  });
  function guard(event) {
    if (classify(event.url, origin) === 'local') return;
    event.preventDefault();
    if (event.isMainFrame) openWeb(event.url);
  }
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', event => event.preventDefault());
}

function allowDownload(urls, origin) {
  return urls.length > 0 && urls.every(url => classify(url, origin) === 'local') &&
    /^\/podcasts\/[\w-]+\/[^/]+\.mp3$/i.test(new URL(urls.at(-1)).pathname);
}

module.exports = { DESKTOP_ORIGIN, classify, guardNavigation, allowDownload };
