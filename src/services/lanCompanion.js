'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { isIPv4, isIPv6, SocketAddress } = require('node:net');
const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { Readable, pipeline } = require('node:stream');
const { promisify } = require('node:util');
const express = require('express');
const { checkId, InputError } = require('./validation');
const { redactCollectionText } = require('./collectionStore');
const { createPodcastCatalog } = require('./taskManager');
const { generateQrSvg } = require('./qrSvg');

const VIRTUAL = /^(?:utun|tun|tap|vmnet|veth|docker|br-|tailscale|wg|lo|wsl|vboxnet|hyper-v|zerotier|clash|mihomo|sing-box|shadowsocks|bridge|awdl|llw|anpi)/i;
function discoverLanCandidates(interfaces = os.networkInterfaces()) {
  const ranks = [];
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const { address, family, internal } of entries || []) {
      if (internal || !['IPv4', 4].includes(family) || !isIPv4(address) || address === '0.0.0.0') continue;
      const [a, b] = address.split('.').map(Number);
      let rank = 3;
      if (a === 192 && b === 168) rank = 0;
      else if (a === 10) rank = 1;
      else if (a === 172 && b >= 16 && b <= 31) rank = 2;
      else if (a === 100 && b >= 64 && b <= 127) rank = 4;
      else if (a === 169 && b === 254) rank = 5;
      if (VIRTUAL.test(interfaceName)) rank += 10;
      ranks.push({ interfaceName, address, rank });
    }
  }
  const unique = new Map();
  for (const { interfaceName, address } of ranks.sort((a, b) => a.rank - b.rank)) {
    if (!unique.has(address)) unique.set(address, { interfaceName, address, preferred: !unique.size });
  }
  return [...unique.values()];
}

const COOKIE = 'inkcast_lan_session';
const COOKIE_FLAGS = { httpOnly: true, sameSite: 'strict', path: '/' };
const HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  'Cache-Control': 'no-store',
};
const UNPAIRED = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>拾声集 · 手机随身听</title><link rel="stylesheet" href="/mobile.css"><body bgcolor="#F5F2EB"><main><h1>手机随身听</h1><p>连接已失效或未配对，请在电脑端拾声集 → 手机随身听重新扫码</p></main></body></html>';
const AUTH_ERROR = { success: false, error: '未配对或连接已失效，请在电脑端重新扫码', code: 'LAN_AUTH_REQUIRED' };
const digest = text => createHash('sha256').update(text).digest();
const notRunning = () => Object.assign(new Error('请先开启手机随身听'), { statusCode: 409 });

const BASE_FIELDS = ['id', 'collectionId', 'highlightCount', 'podcastTitle', 'summary', 'podcastStyle', 'sourceType', 'createAt', 'totalDuration'];
const SUMMARY_FIELDS = [...BASE_FIELDS, 'sentenceCount', 'ttsProvider', 'speechSpeed'];
const DETAIL_FIELDS = [...BASE_FIELDS, 'sentenceGap', 'audioVersion', 'updatedAt'];
const SENTENCE_FIELDS = ['index', 'speaker', 'emotion', 'text', 'startTime', 'endTime', 'duration'];
const HIGHLIGHT_FIELDS = ['id', 'text', 'quote', 'speaker', 'createdAt', 'sentenceIndex', 'startTime', 'endTime'];

function project(record, fields, sensitive) {
  const result = {};
  for (const key of fields) {
    const value = record[key];
    if (typeof value === 'string') result[key] = redactCollectionText(value, sensitive);
    else if (value === null || Number.isFinite(value)) result[key] = value;
  }
  return result;
}

function podcastFields(podcast, fields, sensitive) {
  checkId(podcast.id);
  const data = project(podcast, fields, sensitive);
  // Reconstruct a local media URL even for older or malformed metadata.
  const base = '/podcasts/' + data.id + '/full_podcast.mp3';
  const query = podcast.fullAudioUrl?.startsWith(base) ? podcast.fullAudioUrl.slice(base.length) : '';
  data.fullAudioUrl = base + (/^\?v=[A-Za-z0-9_-]{1,128}$/.test(query) ? query : '');
  return data;
}

function byteRanges(header, size) {
  if (!/^bytes=/i.test(header) || !size) return [];
  const parts = header.slice(6).split(',');
  // Bound the amount of framing and disk seeking a single request can cause.
  if (parts.length > 16) return [];
  const ranges = [];
  for (const part of parts) {
    const match = /^(\d*)-(\d*)$/.exec(part.trim());
    if (!match || (!match[1] && !match[2])) return [];
    const eof = BigInt(size - 1);
    if (match[1]) {
      const start = BigInt(match[1]), end = match[2] ? BigInt(match[2]) : eof;
      if (match[2] && end < start) return [];
      if (start <= eof) ranges.push({ start: Number(start), end: Number(end < eof ? end : eof) });
    } else {
      const length = BigInt(match[2]);
      if (length) ranges.push({ start: length >= size ? 0 : size - Number(length), end: size - 1 });
    }
  }
  return ranges;
}

const readBytes = promisify(fs.read);
async function* multipartAudio(fd, parts, trailer) {
  for (const { header, start, end } of parts) {
    yield header;
    for (let pos = start; pos <= end;) {
      const buffer = Buffer.allocUnsafe(Math.min(end - pos + 1, 64 * 1024));
      const { bytesRead } = await readBytes(fd, buffer, 0, buffer.length, pos);
      if (!bytesRead) throw new Error('音频读取中断');
      yield buffer.subarray(0, bytesRead);
      pos += bytesRead;
    }
    yield '\r\n';
  }
  yield trailer;
}

function attachment(title, id) {
  const clean = String(title || '').toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f"'\\/:*?<>|]/g, '').trim();
  const name = [...clean].slice(0, 100).join('') || id;
  const encoded = encodeURIComponent(name + '.mp3').replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
  return `attachment; filename="inkcast-podcast.mp3"; filename*=UTF-8''${encoded}`;
}

function serveAudio(req, res, readPodcast, podcastsDir, sensitive) {
  const match = /^\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+\.mp3)$/.exec(req.path);
  if (!match || match[2].startsWith('.')) return res.sendStatus(404);
  const [, id, name] = match;
  checkId(id);
  const root = fs.realpathSync(podcastsDir);
  const dir = path.join(root, id);
  if (!fs.lstatSync(dir).isDirectory()) return res.sendStatus(404);
  const realDir = fs.realpathSync(dir);
  if (path.dirname(realDir) !== root) return res.sendStatus(404);

  let podcast;
  try {
    podcast = readPodcast(id);
  } catch (error) {
    if (error.code === 'PODCAST_RECOVERY_FAILED') return res.sendStatus(404);
    throw error;
  }
  if (!podcast) return res.sendStatus(404);
  // name is already a safe basename. Compare it verbatim so foreign URLs,
  // nested paths and encoded separators cannot authorize a different file.
  const mediaPath = `/podcasts/${id}/${name}`;
  const matchesUrl = url => typeof url === 'string' && url.split(/[?#]/, 1)[0] === mediaPath;
  if (name !== 'full_podcast.mp3' && !matchesUrl(podcast.fullAudioUrl) &&
      !podcast.sentences?.some(sentence => sentence?.fileName === name || matchesUrl(sentence?.audioUrl))) {
    return res.sendStatus(404);
  }
  const file = fs.realpathSync(path.join(realDir, name));
  if (file !== path.join(realDir, name)) return res.sendStatus(404);

  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  let stream;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return res.sendStatus(404);
    const { size } = stat;
    res.set('Accept-Ranges', 'bytes');
    const partial = req.headers.range !== undefined;
    const ranges = partial ? byteRanges(req.headers.range, size) : [{ start: 0, end: size - 1 }];
    if (!ranges.length) return res.set('Content-Range', 'bytes */' + size).status(416).end();
    if (req.query.download === '1') {
      const title = podcast.podcastTitle;
      res.set('Content-Disposition', attachment(typeof title === 'string' && redactCollectionText(title, sensitive), id));
    }
    if (partial) res.status(206);
    if (ranges.length > 1) {
      const boundary = randomBytes(16).toString('hex');
      const parts = ranges.map(({ start, end }) => ({ start, end,
        header: `--${boundary}\r\nContent-Type: audio/mpeg\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n` }));
      const trailer = `--${boundary}--\r\n`;
      const length = parts.reduce((n, p) => n + p.header.length + p.end - p.start + 1 + 2, trailer.length);
      res.set('Content-Type', 'multipart/byteranges; boundary=' + boundary).set('Content-Length', String(length));
      if (req.method === 'HEAD') return res.end();
      stream = Readable.from(multipartAudio(fd, parts, trailer));
      pipeline(stream, res, () => fs.close(fd, () => {}));
      return;
    }
    const range = ranges[0];
    if (partial) res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.type('audio/mpeg').set('Content-Length', String(range.end - range.start + 1));
    if (req.method === 'HEAD' || !size) return res.end();
    stream = fs.createReadStream(file, { fd, ...range });
    pipeline(stream, res, () => {});
  } finally {
    if (!stream) fs.closeSync(fd);
  }
}

function hasDirDiskState(dir) {
  if (fs.lstatSync(path.join(dir, 'meta.json'), { throwIfNoEntry: false })?.isFile()) return true;
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(entry =>
      entry.isDirectory() && entry.name.startsWith('.tmp-publish-'));
  } catch {
    return false;
  }
}

function hasDiskMetadata(podcastsDir, id) {
  if (!podcastsDir) return false;
  if (id !== undefined) return hasDirDiskState(path.join(podcastsDir, id));
  try {
    return fs.readdirSync(podcastsDir, { withFileTypes: true }).some(entry =>
      entry.isDirectory() && hasDirDiskState(path.join(podcastsDir, entry.name)));
  } catch {
    return false;
  }
}

function createLanCompanion({ manager, getManager = () => manager, collectionStore, publicDir, podcastsDir,
  getLanInterfaces = os.networkInterfaces, bindHost, sensitive = [] }) {
  if (bindHost !== undefined) {
    const address = isIPv6(bindHost) ? new SocketAddress({ address: bindHost, family: 'ipv6' }).address : bindHost;
    if ((!isIPv4(bindHost) && !isIPv6(bindHost)) || ['0.0.0.0', '::', '::ffff:0.0.0.0'].includes(address)) {
      throw new InputError('监听地址必须是具体的 IP 地址');
    }
  }
  const catalog = podcastsDir ? createPodcastCatalog({ podcastsDir, collectionStore, extraSecrets: sensitive }) : null;
  function readList() {
    const mgr = getManager();
    if (mgr?.listPodcastsReadOnly) return mgr.listPodcastsReadOnly();
    if (catalog && (!mgr || hasDiskMetadata(podcastsDir))) return catalog.listPodcasts();
    return mgr?.listPodcasts?.({ reconcile: false }) ?? { items: [] };
  }
  function readOne(id) {
    checkId(id);
    const mgr = getManager();
    if (mgr?.getPodcastReadOnly) return mgr.getPodcastReadOnly(id);
    if (catalog && (!mgr || hasDiskMetadata(podcastsDir, id))) return catalog.getPodcast(id);
    return mgr?.getPodcast?.(id, { reconcile: false }) ?? null;
  }
  function candidates() {
    try { return discoverLanCandidates(getLanInterfaces()); }
    catch (error) {
      if (error.code === 'ERR_SYSTEM_ERROR') return [];
      throw error;
    }
  }
  let current = null;
  let pending = Promise.resolve();

  function credentials(state) {
    state.pairToken = randomBytes(32).toString('hex');
    state.sessionSecret = randomBytes(32);
    state.paired = false;
    state.url = null;
    state.qrSvg = null;
  }

  function status() {
    const hosts = candidates();
    if (!current?.server?.listening) return { running: false, port: null, activeHost: null, candidates: hosts,
      url: null, qrSvg: null, connectedHint: '' };
    const port = current.server.address().port;
    const url = `http://${current.host}:${port}/listen?t=${current.pairToken}`;
    if (current.url !== url) {
      current.qrSvg = generateQrSvg(url);
      current.url = url;
    }
    return { running: true, port, activeHost: current.host, candidates: hosts, url, qrSvg: current.qrSvg,
      connectedHint: current.paired ? '已有设备完成配对' : '等待手机扫码配对' };
  }

  function chooseHost(host) {
    const hosts = candidates();
    if (!hosts.length) throw new InputError('未检测到可用的局域网 IPv4 地址，请确认电脑已连接 Wi-Fi 或有线网络');
    if (host === undefined) return hosts[0].address;
    if (!hosts.some(item => item.address === host)) throw new InputError('请选择当前网卡列表中的 IPv4 地址');
    return host;
  }

  function companionApp(state) {
    const app = express();
    app.disable('x-powered-by');
    app.enable('case sensitive routing');
    const sign = nonce => createHmac('sha256', state.sessionSecret).update(nonce).digest();
    function paired(req) {
      const cookie = /(?:^|;\s*)inkcast_lan_session=([0-9a-f]{64})\.([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '');
      return cookie && timingSafeEqual(sign(cookie[1]), Buffer.from(cookie[2], 'hex'));
    }
    function sendAsset(res, name) {
      if (!fs.lstatSync(path.join(publicDir, name), { throwIfNoEntry: false })?.isFile()) return res.sendStatus(404);
      return res.sendFile(name, { root: publicDir });
    }
    function auth(req, res, next) {
      if (!paired(req)) return res.status(401).json(AUTH_ERROR);
      next();
    }
    app.use((req, res, next) => {
      res.set(HEADERS);
      if (!['GET', 'HEAD'].includes(req.method)) return res.set('Allow', 'GET, HEAD').sendStatus(405);
      if (current !== state) return res.status(401).json(AUTH_ERROR);
      next();
    });
    app.get('/', (req, res) => {
      const token = req.query.t;
      res.redirect(token === undefined ? '/listen' : '/listen?t=' + encodeURIComponent(typeof token === 'string' ? token : ''));
    });
    app.get('/listen', (req, res) => {
      const token = req.query.t;
      if (token !== undefined) {
        if (typeof token === 'string' && timingSafeEqual(digest(token), digest(state.pairToken))) {
          const nonce = randomBytes(32).toString('hex');
          state.paired = true;
          return res.cookie(COOKIE, nonce + '.' + sign(nonce).toString('hex'), COOKIE_FLAGS).redirect('/listen');
        }
        res.clearCookie(COOKIE, COOKIE_FLAGS);
      } else if (paired(req)) {
        return sendAsset(res, 'mobile.html');
      }
      res.status(401).type('html').send(UNPAIRED);
    });
    for (const name of ['mobile.css', 'mobile.js', 'icon.png']) {
      app.get('/' + name, (_req, res) => sendAsset(res, name));
    }
    app.use('/api/companion', auth);
    app.get('/api/companion/collections', (_req, res) => {
      res.json({ success: true, data: collectionStore.listCollections(readList().items) });
    });
    app.get('/api/companion/podcasts', (req, res) => {
      const filter = req.query.collectionId;
      const items = readList().items
        .filter(p => filter === undefined || filter === 'all' || (p.collectionId ?? null) === (filter === 'unassigned' ? null : filter))
        .map(p => podcastFields(p, SUMMARY_FIELDS, sensitive));
      res.json({ success: true, data: { items } });
    });
    app.get('/api/companion/podcasts/:id', (req, res) => {
      checkId(req.params.id);
      const p = readOne(req.params.id);
      if (!p) return res.sendStatus(404);
      const data = podcastFields(p, DETAIL_FIELDS, sensitive);
      data.sentences = (p.sentences || []).map(s => project(s, SENTENCE_FIELDS, sensitive));
      data.highlights = (collectionStore.getPodcastHighlights?.(p.id) ?? []).map(h => project(h, HIGHLIGHT_FIELDS, sensitive));
      res.json({ success: true, data });
    });
    app.use('/podcasts', auth, (req, res) => serveAudio(req, res, readOne, podcastsDir, sensitive));
    app.use((_req, res) => res.sendStatus(404));
    app.use((err, _req, res, next) => {
      if (res.headersSent) return next(err);
      const missing = ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(err.code);
      res.status(missing ? 404 : err.statusCode || err.status || 500).json({ success: false, error: '无法读取该资源' });
    });
    return app;
  }

  function createCompanionServer(state) {
    const server = http.createServer(companionApp(state));
    // Node dispatches CONNECT outside the ordinary request listener.
    server.on('connect', (req, socket) => {
      state.connectSockets.add(socket);
      socket.once('close', () => state.connectSockets.delete(socket));
      socket.once('error', () => state.connectSockets.delete(socket));
      const res = new http.ServerResponse(req);
      res.assignSocket(socket);
      res.once('finish', () => socket.destroy());
      res.once('error', () => socket.destroy());
      res.writeHead(405, { ...HEADERS, Allow: 'GET, HEAD', Connection: 'close', 'Content-Length': 0 });
      res.end();
    });
    return server;
  }

  async function bind(state, host, port) {
    const server = createCompanionServer(state);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bindHost ?? host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    state.server = server;
    state.host = host;
  }

  async function closeServer(state) {
    const server = state.server;
    if (!server?.listening) return;
    await new Promise(resolve => {
      server.close(resolve);
      for (const socket of state.connectSockets) socket.destroy();
      server.closeAllConnections();
    });
  }

  function revoke(state) {
    if (current === state) current = null;
    state.pairToken = state.qrSvg = state.url = null;
    state.sessionSecret.fill(0);
  }

  function enqueue(action) {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  }

  // Keep listener changes ordered, while letting stop revoke a session immediately.
  function whileCurrent(state, action) {
    return enqueue(async () => {
      if (!state || current !== state) throw notRunning();
      await action();
      if (current !== state) throw notRunning();
      return status();
    });
  }

  async function rebind(state, nextHost) {
    const host = chooseHost(nextHost);
    const prevHost = state.host;
    if (host === prevHost) return;
    const port = state.server.address().port;
    await closeServer(state);
    if (current !== state) throw notRunning();
    try {
      await bind(state, host, port);
    } catch (error) {
      if (current === state) {
        try { await bind(state, prevHost, port); }
        catch { revoke(state); }
      }
      throw error;
    }
  }

  async function start({ host, port = 0 } = {}) {
    if (current) {
      const state = current;
      return whileCurrent(state, () => {
        if (host !== undefined) return rebind(state, host);
      });
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InputError('端口无效');
    const state = { host: chooseHost(host), connectSockets: new Set() };
    credentials(state);
    current = state;
    return whileCurrent(state, async () => {
      try { await bind(state, state.host, port); }
      catch (error) { revoke(state); throw error; }
    });
  }

  function stop() {
    const state = current;
    if (state) revoke(state);
    return enqueue(async () => {
      if (state) await closeServer(state);
      return status();
    });
  }

  function rotate() {
    const state = current;
    return whileCurrent(state, () => {
      state.sessionSecret.fill(0);
      credentials(state);
      state.server.closeAllConnections();
    });
  }

  function selectHost(host) {
    const state = current;
    return whileCurrent(state, () => {
      if (host === undefined) throw new InputError('请选择网卡地址');
      return rebind(state, host);
    });
  }

  return { status, start, stop, rotate, selectHost };
}

module.exports = { discoverLanCandidates, createLanCompanion };
