'use strict';

function classify(raw, origin) {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return 'deny';
    return url.origin === origin ? 'local' : 'external';
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

module.exports = { classify, guardNavigation, allowDownload };
