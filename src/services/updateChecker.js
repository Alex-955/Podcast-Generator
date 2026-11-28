'use strict';

const https = require('node:https');
const { load } = require('cheerio');
const { version: APP_VERSION } = require('../../package.json');
const { redactProviderDetail } = require('./providerHttp');
const { redactSecrets } = require('./validation');

const DOWNLOAD_PAGE = 'https://podcast.ai955.xyz/#onboarding';
const RELEASE_PAGE = 'https://github.com/Alex-955/Podcast-Generator/releases/latest';
const SOURCES = [
  { source: 'official', url: 'https://podcast.ai955.xyz/latest.json', timeoutMs: 5000, maxBytes: 65536 },
  { source: 'github', url: 'https://api.github.com/repos/Alex-955/Podcast-Generator/releases/latest', timeoutMs: 6000, maxBytes: 262144 },
];

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') || [];
  if (prerelease.some(id => /^0\d+$/.test(id))) return null;
  return { core: match.slice(1, 4), prerelease };
}

function compareIds(a, b) {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA !== numericB) return numericA ? -1 : 1;
  if (numericA && a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isNewer(remote, local) {
  for (let i = 0; i < 3; i++) {
    const delta = compareIds(remote.core[i], local.core[i]);
    if (delta) return delta > 0;
  }
  const a = remote.prerelease, b = local.prerelease;
  if (!a.length || !b.length) return a.length < b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const delta = compareIds(a[i], b[i]);
    if (delta) return delta > 0;
  }
  return a.length > b.length;
}

function safeDecode(value) {
  try { return decodeURIComponent(value); }
  catch { return null; }
}

function safeUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    const url = new URL(value);
    const fragment = url.hash.slice(1);
    const decodedPath = safeDecode(url.pathname);
    const decodedFragment = safeDecode(fragment);
    if (url.username || url.password || url.search || decodedPath === null || decodedFragment === null) return fallback;
    if (/%(?:2f|5c|3a)/i.test(url.pathname) || /%(?:2f|5c|3a)/i.test(decodedFragment)) return fallback;
    if (redactSecrets(url.href) !== url.href || redactSecrets(decodedPath) !== decodedPath ||
        redactProviderDetail(decodedFragment) !== decodedFragment) return fallback;
    if (url.origin === 'https://podcast.ai955.xyz' ||
        (url.origin === 'https://github.com' && /^\/Alex-955\/Podcast-Generator(?:\/|$)/.test(url.pathname))) {
      if (url.protocol === 'https:') return url.href;
    }
  } catch { /* Malformed release links use the built-in destination. */ }
  return fallback;
}

function redactEncodedText(raw) {
  const decoded = safeDecode(raw);
  if (decoded === null) return '***';
  return redactProviderDetail(decoded) === decoded ? raw : '***';
}

function redactUrlPart(part) {
  if (!part) return part;
  const hashIdx = part.indexOf('#');
  const query = hashIdx === -1 ? part : part.slice(0, hashIdx);
  const hash = hashIdx === -1 ? '' : part.slice(hashIdx);
  const safeQuery = !query ? '' : '?' + query.slice(1).split('&').map(segment => {
    if (!segment) return segment;
    const eq = segment.indexOf('=');
    if (eq === -1) return redactEncodedText(segment);
    return redactEncodedText(segment.slice(0, eq)) + '=' + redactEncodedText(segment.slice(eq + 1));
  }).join('&');
  const safeHash = !hash ? '' : '#' + redactEncodedText(hash.slice(1));
  return safeQuery + safeHash;
}

function plainText(value) {
  if (typeof value !== 'string') return '';
  if (/[<&]/.test(value)) {
    const html = load(value, {}, false);
    html('script,style,template').remove();
    value = html.root().text();
  }
  const cleaned = value.replace(/[<>\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '').trim();
  const redacted = redactProviderDetail(cleaned);
  return redacted.replace(/https?:\/\/[^\s"'`<>),\]，。）】》」』；、]+/giu, urlText => {
    const idx = urlText.search(/[?#]/);
    const base = idx === -1 ? urlText : urlText.slice(0, idx);
    const suffix = idx === -1 ? '' : redactUrlPart(urlText.slice(idx));
    if (/%(?:2f|5c|3a)/i.test(base)) {
      const pathPart = base.replace(/^https?:\/\/[^/?#]+/i, '');
      const decodedPath = safeDecode(pathPart);
      if (decodedPath === null) return '***' + suffix;
      const variants = [decodedPath.replace(/^\/+/, '/'), decodedPath.replace(/^\/+/, ''), ...decodedPath.split('/')];
      if (variants.some(item => item && redactProviderDetail(item) !== item)) return '***' + suffix;
    }
    return base + suffix;
  });
}

function notesFrom(lines) {
  const notes = [];
  for (const entry of lines) {
    if (typeof entry !== 'string') continue;
    for (const line of entry.split(/\r\n|[\r\n]/)) {
      const text = plainText(line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/!?\[([^\[\]]*)\]\([^()\s]*(?:\([^()]*\)[^()\s]*)*\)/g, '$1'));
      if (text) notes.push(Array.from(text).slice(0, 120).join(''));
      if (notes.length === 6) return notes;
    }
  }
  return notes;
}

// Only the two fixed endpoints above reach this transport. Node HTTPS does not follow redirects.
async function fetchBody(url, { headers, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await new Promise((resolve, reject) => {
      https.get(url, { agent: false, rejectUnauthorized: true, headers, signal: controller.signal }, resolve)
        .on('error', reject);
    });
    try {
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('Unexpected HTTP status');
      if (Number(response.headers['content-length']) > maxBytes) throw new Error('Update response too large');
      let length = 0;
      const chunks = [];
      for await (const chunk of response) {
        length += chunk.length;
        if (length > maxBytes) throw new Error('Update response too large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, length);
    } finally {
      response.destroy();
    }
  } finally {
    clearTimeout(timer);
  }
}

function offlineResult(currentVersion = APP_VERSION) {
  return {
    currentVersion, checked: false, hasUpdate: false, offline: true,
    message: plainText('暂无法连接更新服务，请稍后重试'), downloadPageUrl: DOWNLOAD_PAGE, releaseUrl: RELEASE_PAGE, notes: [],
  };
}

function createUpdateChecker({
  fetcher = fetchBody, now = Date.now, currentVersion = APP_VERSION,
  cacheTtlMs = 6 * 60 * 60 * 1000, forceThrottleMs = 10000,
} = {}) {
  const local = parseVersion(currentVersion);
  if (!local) throw new TypeError('Invalid current version');
  let success, lastAttempt, inFlight;

  async function refresh() {
    for (const { source, url, timeoutMs, maxBytes } of SOURCES) {
      const github = source === 'github';
      const headers = github ? { 'User-Agent': 'InkCast/' + currentVersion, Accept: 'application/vnd.github+json' } : {};
      try {
        const body = await fetcher(url, { method: 'GET', headers, timeoutMs, maxBytes });
        let payload = body;
        if (typeof body === 'string' || Buffer.isBuffer(body)) {
          if (Buffer.byteLength(body) > maxBytes) continue;
          payload = JSON.parse(body);
        }
        const version = github ? payload.tag_name : payload.version;
        const remote = parseVersion(version);
        if (!remote || redactProviderDetail(version) !== version || (github && (payload.draft === true || payload.prerelease === true))) continue;

        const time = now();
        const lines = github ? [payload.body] : payload.notes;
        const result = {
          currentVersion, latestVersion: version.replace(/^[vV]/, ''), hasUpdate: isNewer(remote, local),
          checked: true, offline: false, source, releaseDate: plainText(github ? payload.published_at : payload.releaseDate),
          notes: notesFrom(Array.isArray(lines) ? lines : []),
          downloadPageUrl: safeUrl(github ? undefined : payload.downloadPageUrl, DOWNLOAD_PAGE),
          releaseUrl: safeUrl(github ? payload.html_url : payload.releaseUrl, RELEASE_PAGE),
          checkedAt: new Date(time).toISOString(),
        };
        lastAttempt = success = { result, time };
        return result;
      } catch { /* Try the next source without exposing upstream errors or data. */ }
    }
    lastAttempt = { result: offlineResult(currentVersion), time: now() };
    return lastAttempt.result;
  }

  async function checkForUpdates({ force = false } = {}) {
    if (inFlight) return inFlight;
    const cached = force ? lastAttempt : success;
    const ttl = force ? forceThrottleMs : cacheTtlMs;
    if (cached && now() - cached.time < ttl) return cached.result;
    inFlight = refresh().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  return { checkForUpdates };
}

module.exports = { createUpdateChecker, offlineResult };
