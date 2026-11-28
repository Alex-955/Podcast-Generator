'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { encodeQrMatrix, generateQrSvg } = require('../src/services/qrSvg');
const { createLanCompanion, discoverLanCandidates } = require('../src/services/lanCompanion');
const { createCollectionStore } = require('../src/services/collectionStore');
const { createApp, startServer } = require('../server');

const urlText = 'http://192.168.1.100:54321/listen?t=' + 'ab'.repeat(32);
const entry = (address, family = 'IPv4', internal = false) => ({ family, address, internal });
const hosts = () => ({ en0: [entry('192.168.1.123')], eth1: [entry('10.10.0.2')] });
const loopbackHosts = () => ({ en0: [entry('127.0.0.1')] });

test('QR M 级矩阵按容量选择版本，定位符、时序、暗模块和 SVG 留白符合规格', () => {
  // The first payload length requiring each version (byte mode, level M).
  const lengths = [1, 15, 27, 43, 63, 85, 107, 123, 153, 181, 214, 252, 288, 332, 363];
  for (const [i, length] of lengths.entries()) {
    assert.equal(encodeQrMatrix('a'.repeat(length)).length, 17 + 4 * (i + 1));
  }
  const matrix = encodeQrMatrix(urlText, 'M'), size = matrix.length;
  assert.equal(size, 41);
  for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = 0; dy <= 6; dy++) for (let dx = 0; dx <= 6; dx++) {
      assert.equal(matrix[y + dy][x + dx], Math.max(Math.abs(3-dx), Math.abs(3-dy)) !== 2);
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(matrix[6][i], i % 2 === 0);
    assert.equal(matrix[i][6], i % 2 === 0);
  }
  assert.equal(matrix[size - 8][8], true);
  const svg = generateQrSvg(urlText);
  assert.match(svg, /viewBox="0 0 49 49"/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /#FFFFFF/);
  assert.match(svg, /#1A1916/);
  assert.doesNotMatch(svg.replace('http://www.w3.org/2000/svg', ''), /https?:|script|href=|foreignObject|onload=/i);
  assert.equal((svg.match(/h1v1h-1z/g) || []).length, matrix.flat().filter(Boolean).length);
  assert.doesNotMatch(generateQrSvg('拾声集<script>'), /<script>/);
  assert.throws(() => generateQrSvg('a', { quietZone: '" onload="' }));
  assert.throws(() => encodeQrMatrix('a'.repeat(500)));
});

test('已由独立解码器读回的二维码矩阵保持完整', () => {
  // These exact matrices were decoded offline with Core Image, including
  // UTF-8 ECI, unequal RS block lengths, and version information.
  const samples = [
    ['http://192.168.1.100:54321/listen?t=' + 'a'.repeat(64), 'e0ddd39199ca1fd23aa816cacf25e6e71f79479d67b11b068de1d145f974e779'],
    ['拾声集：手机随身听', '87a80b70cc4f0e11b9a20fb0f00f45380092a650568c5f27cbde550427144e48'],
    ['a'.repeat(363), '6ec1c1620f89f3370886a1e7735291be2ceecb0ed221594b5d80d24bfb8924c9'],
  ];
  for (const [input, expected] of samples) {
    const pixels = Buffer.from(encodeQrMatrix(input).flat());
    assert.equal(createHash('sha256').update(pixels).digest('hex'), expected);
  }
});

test('macOS 与 Windows 物理私网优先，保留虚拟、CGNAT 和链路本地备选，按地址去重', () => {
  const mac = discoverLanCandidates({ utun3: [entry('192.168.9.1'), entry('10.0.0.8')],
    awdl0: [entry('169.254.0.2')], en1: [entry('10.0.0.8')], en0: [entry('192.168.1.2', 4)],
    lo0: [entry('127.0.0.1', 4, true)], other: [entry('::1', 'IPv6')], empty: undefined });
  assert.deepEqual(mac.map(c => c.interfaceName), ['en0', 'en1', 'utun3', 'awdl0']);
  assert.deepEqual(mac.map(c => c.preferred), [true, false, false, false]);
  const windows = discoverLanCandidates({ Tailscale: [entry('100.64.0.5')], 'vEthernet (WSL)': [entry('192.168.20.1')],
    WLAN: [entry('172.31.8.1')], cell: [entry('100.127.1.1')], link: [entry('169.254.1.1')] });
  assert.deepEqual(windows.map(c => c.interfaceName), ['WLAN', 'cell', 'link', 'vEthernet (WSL)', 'Tailscale']);
  assert.deepEqual(discoverLanCandidates({}), []);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkcast-lan-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const dataDir = path.join(root, 'data'), podcastsDir = path.join(root, 'episodes'), publicDir = path.join(root, 'public');
  for (const dir of [dataDir, publicDir, path.join(podcastsDir, 'ep')]) fs.mkdirSync(dir, { recursive: true });
  for (const file of ['mobile.html', 'mobile.css', 'mobile.js', 'icon.png', 'app.js', 'index.html', 'style.css']) {
    fs.writeFileSync(path.join(publicDir, file), file);
  }
  const audio = Buffer.from('0123456789');
  fs.writeFileSync(path.join(podcastsDir, 'ep/full_podcast.mp3'), audio);
  const collectionStore = createCollectionStore({ dataDir, podcastsDir });
  const collection = collectionStore.createCollection({ name: '我的合集' });
  collectionStore.setPodcastCollection('ep', collection.id);
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'collections.json')));
  store.highlights.ep = [{ text: '离线金句', sentenceIndex: 0, filePath: root }];
  fs.writeFileSync(path.join(dataDir, 'collections.json'), JSON.stringify(store));
  const token = 'private-credential';
  const episode = { id: 'ep', collectionId: collection.id, highlightCount: 1, podcastTitle: '声"音/\r\n一期', summary: '摘要',
    podcastStyle: 'dialogue', sourceType: 'text', createAt: '2025-01-01', totalDuration: 2, sentenceGap: 0,
    sentenceCount: 1, audioVersion: 'v1', updatedAt: '2025-01-02', ttsProvider: 'edge', speechSpeed: 'standard',
    fullAudioUrl: '/podcasts/ep/full_podcast.mp3?v=v1', filePath: root, apiKey: token, voiceMapping: { host: 'test' },
    sentences: [{ index: 0, speaker: '主持人', emotion: '平静', text: '你好', startTime: 0, endTime: 2, duration: 2,
      audioUrl: root, credentials: token }] };
  const reconciled = [];
  const manager = { listPodcasts: () => ({ items: [episode, { ...episode, id: 'other', collectionId: null }] }),
    getPodcast: id => id === 'ep' ? episode : null, reconcilePodcast: id => reconciled.push(id) };
  return { root, dataDir, podcastsDir, publicDir, manager, collectionStore, collection, token, reconciled };
}

async function mainServer(t, f, extra = {}) {
  const app = createApp({ dataDir: f.dataDir, podcastsDir: f.podcastsDir, publicDir: f.publicDir,
    taskManager: f.manager, collectionStore: f.collectionStore, getLanInterfaces: loopbackHosts, ...extra });
  const handle = await startServer({ app, host: '127.0.0.1', port: 0 });
  t.after(() => handle.close());
  async function control(name, body, headers) {
    const response = await fetch('http://127.0.0.1:' + handle.port + '/api/lan-companion/' + name, {
      method: name === 'status' ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });
    const json = await response.json();
    return { status: response.status, headers: response.headers, ...json };
  }
  return { app, handle, control };
}

function mobile(port, route, options = {}) {
  return fetch('http://127.0.0.1:' + port + route, { redirect: 'manual', ...options });
}

async function pair(port, url) {
  const res = await mobile(port, '/listen' + new URL(url).search, { headers: { connection: 'close' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/listen');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const cookie = res.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag));
  assert.doesNotMatch(cookie, /Secure/i);
  assert.match(cookie, /^inkcast_lan_session=[0-9a-f]{64}\.[0-9a-f]{64};/);
  return cookie.split(';')[0];
}

async function assertReleased(port) {
  const socket = net.connect(port, '127.0.0.1');
  try { await assert.rejects(once(socket, 'connect'), { code: 'ECONNREFUSED' }); }
  finally { socket.destroy(); }
}

test('主服务控制启动、复用、切换、轮换和停止，关闭时收回监听端口', async t => {
  const f = fixture(t);
  const { app, control } = await mainServer(t, f, { getLanInterfaces: hosts });
  const listen = http.Server.prototype.listen;
  const bindings = [];
  t.mock.method(http.Server.prototype, 'listen', function (port, host, ready) {
    bindings.push(host);
    assert.ok(discoverLanCandidates(hosts()).some(candidate => candidate.address === host));
    return listen.call(this, port, '127.0.0.1', ready);
  });
  const initial = (await control('status')).data;
  assert.deepEqual(initial, { running: false, port: null, activeHost: null, url: null, qrSvg: null,
    candidates: discoverLanCandidates(hosts()), connectedHint: '' });
  assert.equal((await control('start', undefined, { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await control('status', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await control('rotate')).status, 409);
  assert.equal((await control('select-host', { host: '10.10.0.2' })).status, 409);
  assert.equal((await control('start', { host: '1.1.1.1' })).status, 400);
  const { data: live, headers } = await control('start');
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.equal(live.running, true);
  assert.match(live.url, /^http:\/\/192\.168\.1\.123:\d+\/listen\?t=[a-f0-9]{64}$/);
  assert.equal(live.qrSvg, generateQrSvg(live.url));
  assert.deepEqual((await control('status')).data, live);
  assert.deepEqual((await control('start')).data, live);
  const cookie = await pair(live.port, live.url);
  assert.equal((await control('select-host', { host: '127.0.0.1' })).status, 400);
  const selected = (await control('select-host', { host: '10.10.0.2' })).data;
  assert.deepEqual(bindings, ['192.168.1.123', '10.10.0.2']);
  assert.equal(new URL(selected.url).hostname, '10.10.0.2');
  assert.equal(new URL(selected.url).search, new URL(live.url).search);
  assert.notEqual(selected.qrSvg, live.qrSvg);
  assert.equal((await mobile(live.port, '/listen', { headers: { cookie } })).status, 200);
  const rotated = (await control('rotate')).data;
  assert.notEqual(new URL(rotated.url).search, new URL(live.url).search);
  const invalid = await mobile(live.port, '/listen' + new URL(live.url).search, { headers: { cookie } });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  for (const route of ['/listen', '/api/companion/podcasts', '/podcasts/ep/full_podcast.mp3']) {
    assert.equal((await mobile(live.port, route, { headers: { cookie } })).status, 401);
  }
  await pair(live.port, rotated.url);
  assert.deepEqual((await control('stop')).data, initial);
  await assertReleased(live.port);
  const restarted = (await control('start')).data;
  assert.notEqual(new URL(restarted.url).search, new URL(rotated.url).search);
  await app.shutdown();
  await assertReleased(restarted.port);
  assert.equal((await control('start')).status, 503);
});

test('手机服务仅放行白名单，配对保护页面、数据、音频，响应头一致', async t => {
  const f = fixture(t);
  const service = createLanCompanion({ ...f, bindHost: '127.0.0.1', getLanInterfaces: hosts });
  t.after(() => service.stop());
  const { port, url } = await service.start();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await mobile(port, '/api/companion/podcasts', { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  const tunnelRequest = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'localhost:80' });
  const tunnelResponse = once(tunnelRequest, 'connect');
  tunnelRequest.end();
  const [rejected, socket] = await tunnelResponse;
  socket.destroy();
  assert.equal(rejected.statusCode, 405);
  assert.equal(rejected.headers.allow, 'GET, HEAD');
  for (const route of ['/api/tasks', '/api/settings', '/api/collections', '/api/lan-companion/status',
    '/index.html', '/app.js', '/style.css', '/mobile.html', '/mobile.js%2f..%2fapp.js']) {
    assert.equal((await mobile(port, route)).status, 404);
  }
  for (const route of ['/mobile.css', '/mobile.js', '/icon.png']) assert.equal((await mobile(port, route)).status, 200);
  const redirect = await mobile(port, '/?extra=private&t=abc');
  assert.equal(redirect.headers.get('location'), '/listen?t=abc');
  assert.equal((await mobile(port, '/')).headers.get('location'), '/listen');
  const page = await mobile(port, '/listen');
  assert.equal(page.status, 401);
  assert.doesNotMatch(await page.text(), /<script/i);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const route of ['/api/companion/podcasts', '/api/companion/collections', '/api/companion/podcasts/ep', '/podcasts/ep/full_podcast.mp3']) {
    const denied = await mobile(port, route);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { success: false, error: '未配对或连接已失效，请在电脑端重新扫码', code: 'LAN_AUTH_REQUIRED' });
  }
  const cookie = await pair(port, url), headers = { cookie };
  const forged = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  assert.equal((await mobile(port, '/listen', { headers: { cookie: forged } })).status, 401);
  const home = await mobile(port, '/listen', { headers });
  assert.equal(await home.text(), 'mobile.html');
  assert.equal(home.headers.get('cache-control'), 'no-store');
  async function data(route) {
    const res = await mobile(port, '/api/companion/' + route, { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const text = await res.text();
    for (const secret of [f.root, f.token, '"apiKey"', '"voiceMapping"', '"filePath"', '"credentials"', '"audioUrl"']) {
      assert.ok(!text.includes(secret));
    }
    return JSON.parse(text).data;
  }
  const collections = await data('collections');
  assert.equal(collections.items[0].name, '我的合集');
  assert.equal(collections.items[0].highlightCount, 1);
  assert.deepEqual((await data('podcasts?collectionId=all')).items.map(p => p.id), ['ep', 'other']);
  assert.deepEqual((await data('podcasts?collectionId=unassigned')).items.map(p => p.id), ['other']);
  const { items } = await data('podcasts?collectionId=' + f.collection.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'ep');
  assert.equal(items[0].sentenceCount, 1);
  assert.equal(items[0].ttsProvider, 'edge');
  assert.equal(items[0].sentences, undefined);
  const detail = await data('podcasts/ep');
  assert.deepEqual(detail.sentences, [{ index: 0, speaker: '主持人', emotion: '平静', text: '你好', startTime: 0, endTime: 2, duration: 2 }]);
  assert.deepEqual(detail.highlights, [{ text: '离线金句', sentenceIndex: 0 }]);
  assert.equal(detail.fullAudioUrl, '/podcasts/ep/full_podcast.mp3?v=v1');
  f.collectionStore.getPodcastHighlights('ep')[0].text = '改写副本';
  assert.equal(f.collectionStore.getPodcastHighlights('ep')[0].text, '离线金句');
  assert.equal((await mobile(port, '/api/companion/podcasts/bad%2Fid', { headers })).status, 400);
});

test('MP3 支持完整读取、HEAD、区间、后缀和下载，拒绝越界和符号链接逃逸', async t => {
  const f = fixture(t);
  const service = createLanCompanion({ ...f, bindHost: '127.0.0.1', getLanInterfaces: hosts });
  t.after(() => service.stop());
  const { port, url } = await service.start(), cookie = await pair(port, url);
  const audio = '/podcasts/ep/full_podcast.mp3';
  const full = await mobile(port, audio + '?download=1', { headers: { cookie } });
  assert.equal(await full.text(), '0123456789');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const disposition = full.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="inkcast-podcast.mp3"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(disposition.split("''")[1]), '声音一期.mp3');
  for (const [range, expect, body] of [['bytes=2-4', '2-4', '234'], ['bytes=8-', '8-9', '89'],
    ['bytes=-3', '7-9', '789'], ['bytes=9-999', '9-9', '9'], ['bytes=-99', '0-9', '0123456789']]) {
    const partial = await mobile(port, audio, { headers: { cookie, range } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes ' + expect + '/10');
    assert.equal(partial.headers.get('content-length'), String(body.length));
    assert.equal(await partial.text(), body);
  }
  const multipart = await mobile(port, audio, { headers: { cookie, range: 'bytes=0-1, 7-8, 100-' } });
  assert.equal(multipart.status, 206);
  assert.match(multipart.headers.get('content-type'), /^multipart\/byteranges; boundary=/);
  const body = await multipart.text();
  assert.equal(multipart.headers.get('content-length'), String(Buffer.byteLength(body)));
  assert.ok(body.includes('Content-Range: bytes 0-1/10\r\n\r\n01\r\n'));
  assert.ok(body.includes('Content-Range: bytes 7-8/10\r\n\r\n78\r\n'));
  const head = await mobile(port, audio, { method: 'HEAD', headers: { cookie, range: 'bytes=1-2' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '2');
  assert.equal(await head.text(), '');
  for (const range of ['bytes=20-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=junk']) {
    const response = await mobile(port, audio, { headers: { cookie, range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
  assert.deepEqual(f.reconciled, []);
  const outside = path.join(f.root, 'private.mp3');
  fs.writeFileSync(outside, 'private');
  fs.symlinkSync(f.root, path.join(f.podcastsDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const forbidden = ['/podcasts/linked/private.mp3', '/podcasts/ep/..%2fprivate.mp3', '/podcasts/ep/meta.json'];
  if (process.platform !== 'win32') {
    f.manager.getPodcast('ep').sentences.push({ fileName: 'link.mp3' });
    fs.symlinkSync(outside, path.join(f.podcastsDir, 'ep/link.mp3'));
    forbidden.push('/podcasts/ep/link.mp3');
  }
  for (const route of forbidden) assert.equal((await mobile(port, route, { headers: { cookie } })).status, 404);
});

test('音频按只读发布清单放行完整文件和分段，孤立文件与未发布音频均不可读', async t => {
  const f = fixture(t);
  const dir = path.join(f.podcastsDir, 'ep');
  const files = ['release.mp3', 'by-name.mp3', 'by-url.mp3', 'orphan.mp3'];
  for (const file of files) fs.writeFileSync(path.join(dir, file), file);
  const episode = { id: 'ep', podcastTitle: '试听', fullAudioUrl: '/podcasts/ep/release.mp3?v=2',
    sentences: [{ fileName: 'by-name.mp3' }, { audioUrl: '/podcasts/ep/by-url.mp3?v=2' },
      { audioUrl: '/podcasts/other/orphan.mp3' }, { fileName: '../orphan.mp3' }] };
  const read = t.mock.fn(() => episode);
  const svc = createLanCompanion({ ...f, manager: { getPodcastReadOnly: read }, bindHost: '127.0.0.1', getLanInterfaces: hosts });
  t.after(() => svc.stop());
  const { port, url } = await svc.start();
  const headers = { cookie: await pair(port, url) };
  for (const file of files) {
    for (const suffix of ['', '?download=1']) {
      const response = await mobile(port, '/podcasts/ep/' + file + suffix, { headers });
      assert.equal(response.status, file === 'orphan.mp3' ? 404 : 200);
      if (response.ok) assert.equal(await response.text(), file);
    }
  }
  assert.equal(read.mock.callCount(), files.length * 2);
  for (const error of [null, { statusCode: 404 }, { statusCode: 503, code: 'PODCAST_RECOVERY_FAILED' }, { code: 'ENOENT' }]) {
    read.mock.mockImplementation(() => { if (error) throw error; return null; });
    for (const suffix of ['', '?download=1']) {
      assert.equal((await mobile(port, '/podcasts/ep/full_podcast.mp3' + suffix, { headers })).status, 404);
    }
  }
});

test('主服务五个控制接口均要求管理权限及配置的桌面会话', async t => {
  for (const extra of [{ adminToken: '', isLoopbackRequest: () => false }, { desktopSessionToken: 'offline-desktop' }]) {
    const { control } = await mainServer(t, fixture(t), extra);
    for (const route of ['status', 'start', 'stop', 'rotate', 'select-host']) {
      const result = await control(route);
      assert.equal(result.status, 403);
      assert.ok(!result.data);
    }
    if (extra.desktopSessionToken) assert.equal((await control('status', undefined, { 'x-desktop-session': extra.desktopSessionToken })).status, 200);
  }
});

test('无候选、端口冲突和启动中关闭均可恢复，重复启动只监听一个端口', async t => {
  const f = fixture(t);
  const { control } = await mainServer(t, f, { getLanInterfaces: () => ({}) });
  assert.match((await control('start')).error, /未检测到/);
  const busy = http.createServer().listen(0, '127.0.0.1');
  await once(busy, 'listening');
  t.after(() => new Promise(resolve => busy.close(resolve)));
  const svc = createLanCompanion({ ...f, bindHost: '127.0.0.1', getLanInterfaces: hosts });
  t.after(() => svc.stop());
  await assert.rejects(svc.start({ port: busy.address().port }), { code: 'EADDRINUSE' });
  assert.equal(svc.status().running, false);
  const pending = svc.start(), stopping = svc.stop();
  await assert.rejects(pending, { statusCode: 409 });
  await stopping;
  const [a, b] = await Promise.all([svc.start(), svc.start()]);
  assert.equal(a.url, b.url);
  await Promise.all([svc.stop(), svc.stop()]);
  await assertReleased(a.port);
});

test('默认监听所选单一 IP，更换网卡关闭旧连接，重复启动与轮换按序执行', async t => {
  const f = fixture(t);
  const loopback = '127.0.0.1', other = '192.0.2.1';
  const getLanInterfaces = () => ({ en0: [entry(loopback), entry(other), entry('0.0.0.0')] });
  for (const bindHost of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '']) {
    assert.throws(() => createLanCompanion({ ...f, getLanInterfaces, bindHost }), { name: 'InputError' });
  }
  const svc = createLanCompanion({ ...f, getLanInterfaces });
  t.after(() => svc.stop());
  await assert.rejects(svc.start({ host: '0.0.0.0' }), { name: 'InputError' });
  const bindings = [];
  const listen = http.Server.prototype.listen;
  // Only the fictional second NIC is mapped to loopback; observe each requested bind.
  t.mock.method(http.Server.prototype, 'listen', function (port, host, ready) {
    bindings.push({ server: this, port, host });
    return listen.call(this, port, host === other ? loopback : host, ready);
  });
  const first = await svc.start();
  assert.equal(bindings[0].server.address().address, loopback);
  const cookie = await pair(first.port, first.url);
  const accepted = once(bindings[0].server, 'connection');
  const socket = net.connect(first.port, loopback);
  t.after(() => socket.destroy());
  await Promise.all([accepted, once(socket, 'connect')]);
  const closed = once(socket, 'close');
  await svc.selectHost(loopback);
  await assert.rejects(svc.selectHost(), { name: 'InputError' });
  const selected = await svc.selectHost(other);
  await closed;
  assert.equal(bindings[0].server.listening, false);
  assert.equal(selected.activeHost, other);
  assert.equal(selected.port, first.port);
  assert.equal(new URL(selected.url).search, new URL(first.url).search);
  assert.equal(selected.connectedHint, '已有设备完成配对');
  assert.equal((await mobile(first.port, '/listen', { headers: { cookie, connection: 'close' } })).status, 200);
  const [back, rotated] = await Promise.all([svc.start({ host: loopback }), svc.rotate()]);
  assert.equal(bindings[1].server.listening, false);
  assert.equal(bindings[2].server.address().address, loopback);
  assert.deepEqual(bindings.map(({ port, host }) => [port, host]), [[0, loopback], [first.port, other], [first.port, loopback]]);
  assert.equal(back.url, first.url);
  assert.notEqual(new URL(rotated.url).search, new URL(first.url).search);
  assert.equal((await mobile(first.port, '/listen', { headers: { cookie, connection: 'close' } })).status, 401);

  // Stop while closing the old listener. A queued switch must never resurrect it.
  const rotatedCookie = await pair(first.port, rotated.url);
  let stopped, restarted;
  bindings[2].server.once('close', () => {
    stopped = svc.stop();
    restarted = svc.start({ host: loopback, port: first.port });
  });
  await assert.rejects(svc.selectHost(other), { statusCode: 409 });
  assert.equal((await stopped).running, false);
  assert.equal((await restarted).activeHost, loopback);
  assert.equal(bindings.filter(({ server }) => server.listening).length, 1);
  assert.equal((await mobile(first.port, '/listen', { headers: { cookie: rotatedCookie } })).status, 401);
});

test('网卡绑定失败时控制接口报告错误，回滚后原端口、配对和二维码仍可用', async t => {
  const loopback = '127.0.0.1', unavailable = '192.0.2.1';
  const { control } = await mainServer(t, fixture(t), {
    getLanInterfaces: () => ({ en0: [entry(loopback), entry(unavailable)] }) });
  const { data: first } = await control('start');
  const cookie = await pair(first.port, first.url);
  const before = (await control('status')).data;
  const attempts = [];
  const listen = http.Server.prototype.listen;
  let failRollback = false;
  t.mock.method(http.Server.prototype, 'listen', function (port, host, ready) {
    attempts.push([port, host]);
    if (host === unavailable || failRollback) {
      const code = host === unavailable ? 'EADDRNOTAVAIL' : 'EADDRINUSE';
      process.nextTick(() => this.emit('error', Object.assign(new Error('bind failed'), { code })));
      return this;
    }
    return listen.call(this, port, host, ready);
  });
  assert.equal((await control('select-host', { host: unavailable })).status, 500);
  assert.deepEqual(attempts, [[first.port, unavailable], [first.port, loopback]]);
  assert.deepEqual((await control('status')).data, before);
  assert.equal((await mobile(first.port, '/listen', { headers: { cookie, connection: 'close' } })).status, 200);
  failRollback = true;
  const failure = await control('select-host', { host: unavailable });
  assert.equal(failure.status, 500);
  assert.equal(failure.code, 'EADDRNOTAVAIL');
  assert.equal((await control('status')).data.running, false);
  await assertReleased(first.port);
  failRollback = false;
  const { data: restarted } = await control('start');
  assert.equal((await mobile(restarted.port, '/listen', { headers: { cookie } })).status, 401);
});

test('只读目录逐个核对事务，忽略无标记或已被更新版本取代的事务', t => {
  const { podcastsDir } = fixture(t);
  const catalog = require('../src/services/taskManager').createPodcastCatalog({ podcastsDir });
  const read = () => catalog.getPodcast('ep');
  const dir = path.join(podcastsDir, 'ep');
  const origMp3 = Buffer.from('0123456789');
  const origMeta = Buffer.from(JSON.stringify({ audioVersion: 'v1' }));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    audioVersion: 'v3', sentences: [{ fileName: '../orphan.mp3' }, { fileName: 'nested/orphan.mp3' }],
  }));
  fs.writeFileSync(path.join(dir, 'orphan.mp3'), 'orphan');
  assert.deepEqual(read().sentences.map(s => s.fileName), [undefined, undefined]);
  const transaction = path.join(dir, '.tmp-publish-tx');
  fs.mkdirSync(transaction);
  assert.equal(read().audioVersion, 'v3');
  const marker = path.join(transaction, 'prepared');
  const origDir = path.join(transaction, 'originals');
  fs.mkdirSync(origDir);
  fs.writeFileSync(path.join(origDir, 'full_podcast.mp3'), origMp3);
  fs.writeFileSync(path.join(origDir, 'meta.json'), origMeta);
  const info = {
    taskId: 'tx', previousVersion: 'v1', targetVersion: 'v2', dialogueCount: 1,
    originals: {
      'full_podcast.mp3': createHash('sha256').update(origMp3).digest('hex'),
      'meta.json': createHash('sha256').update(origMeta).digest('hex'),
    },
  };
  fs.mkdirSync(marker);
  assert.throws(read, { statusCode: 404 });
  fs.rmdirSync(marker);
  for (const bytes of ['{broken', 'null', JSON.stringify({ ...info, taskId: 'other' }),
    JSON.stringify({ ...info, targetVersion: '' }), JSON.stringify({ ...info, previousVersion: 0 }),
    JSON.stringify({ ...info, dialogueCount: undefined }), JSON.stringify({ ...info, dialogueCount: 0 }),
    JSON.stringify({ ...info, originals: undefined }), JSON.stringify({ ...info, originals: null }),
    JSON.stringify({ ...info, originals: { ...info.originals, 'meta.json': 'bad' } })]) {
    fs.writeFileSync(marker, bytes);
    assert.throws(read, { statusCode: 404 });
    assert.equal(fs.readFileSync(marker, 'utf8'), bytes);
  }
  fs.writeFileSync(marker, JSON.stringify(info));
  fs.writeFileSync(path.join(origDir, 'meta.json'), 'tampered');
  assert.throws(read, { statusCode: 404 });
  fs.writeFileSync(path.join(origDir, 'meta.json'), origMeta);
  assert.equal(read().audioVersion, 'v3');
  const invalidDir = path.join(dir, '.tmp-publish-');
  fs.mkdirSync(invalidDir);
  assert.throws(read, { statusCode: 404 });
  fs.rmdirSync(invalidDir);
  fs.writeFileSync(path.join(dir, '.tmp-publish-another'), '');
  assert.throws(read, { statusCode: 404 });
});

test('伴随服务只读访问真实任务管理器时绝不触发发布恢复或修改磁盘，CONNECT 响应后由服务端销毁套接字', async t => {
  const { createTaskManager } = require('../src/services/taskManager');
  const { createCollectionStore } = require('../src/services/collectionStore');
  const { createHash } = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkcast-lan-ro-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const podcastsDir = path.join(root, 'podcasts');
  const epDir = path.join(podcastsDir, 'ep_tx');
  fs.mkdirSync(epDir, { recursive: true });
  fs.writeFileSync(path.join(epDir, 'full_podcast.mp3'), 'new-audio');
  const metaFile = path.join(epDir, 'meta.json');
  const meta = { podcastTitle: '标题', audioVersion: 'v1', sentences: [{ speaker: '阿泽', text: '句子', startTime: 0, endTime: 1 }] };
  const pendingMeta = JSON.stringify(meta);
  const committedMeta = JSON.stringify({ ...meta, audioVersion: 'v2' });
  fs.writeFileSync(metaFile, pendingMeta);

  const collectionStore = createCollectionStore({ dataDir, podcastsDir });
  const manager = createTaskManager({
    tasksDir: path.join(dataDir, 'tasks'), podcastsDir, cacheDir: path.join(dataDir, 'tts-cache'), collectionStore,
  });
  // Write a pending transaction after manager startup so companion GET hits live pending state.
  const origMp3 = Buffer.from('original-audio');
  const origMeta = Buffer.from(JSON.stringify({ podcastTitle: '旧标题', audioVersion: 'v1', sentences: [{ speaker: '阿泽', text: '旧句', startTime: 0, endTime: 1 }] }));
  const txDir2 = path.join(epDir, '.tmp-publish-tx2');
  const origDir2 = path.join(txDir2, 'originals');
  fs.mkdirSync(origDir2, { recursive: true });
  fs.writeFileSync(path.join(origDir2, 'full_podcast.mp3'), origMp3);
  fs.writeFileSync(path.join(origDir2, 'meta.json'), origMeta);
  const preparedBytes = JSON.stringify({
    taskId: 'tx2', previousVersion: 'v1', targetVersion: 'v2', dialogueCount: 1,
    originals: {
      'full_podcast.mp3': createHash('sha256').update(origMp3).digest('hex'),
      'meta.json': createHash('sha256').update(origMeta).digest('hex'),
    },
  });
  fs.writeFileSync(path.join(txDir2, 'prepared'), preparedBytes);

  const svc = createLanCompanion({
    manager, collectionStore, publicDir: path.join(__dirname, '../public'), podcastsDir,
    bindHost: '127.0.0.1', getLanInterfaces: hosts,
  });
  t.after(() => svc.stop());
  const { port, url } = await svc.start();
  const cookie = await pair(port, url);
  async function assertPublication(port, cookie, expectedMeta) {
    const get = route => mobile(port, route, { headers: { cookie } });
    const visible = expectedMeta === committedMeta;
    assert.equal((await get('/api/companion/collections')).status, 200);
    const list = await get('/api/companion/podcasts');
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data.items.some(item => item.id === 'ep_tx'), visible);
    const detail = await get('/api/companion/podcasts/ep_tx');
    assert.equal(detail.status, visible ? 200 : 404);
    if (visible) assert.equal((await detail.json()).data.audioVersion, 'v2');
    for (const suffix of ['', '?download=1']) {
      const audio = await get('/podcasts/ep_tx/full_podcast.mp3' + suffix);
      assert.equal(audio.status, visible ? 200 : 404);
      if (visible) assert.equal(await audio.text(), 'new-audio');
    }
    assert.equal(fs.readFileSync(path.join(txDir2, 'prepared'), 'utf8'), preparedBytes);
    assert.equal(fs.readFileSync(path.join(epDir, 'full_podcast.mp3'), 'utf8'), 'new-audio');
    if (expectedMeta === undefined) assert.equal(fs.existsSync(metaFile), false);
    else assert.equal(fs.readFileSync(metaFile, 'utf8'), expectedMeta);
  }
  await assertPublication(port, cookie, pendingMeta);

  for (const id of ['unfinished', 'invalid_meta']) {
    const dir = path.join(podcastsDir, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), 'unpublished');
    const meta = path.join(dir, 'meta.json');
    if (id === 'invalid_meta') fs.writeFileSync(meta, '{broken');
    for (const suffix of ['', '?download=1']) {
      const response = await mobile(port, `/podcasts/${id}/full_podcast.mp3` + suffix, { headers: { cookie } });
      assert.equal(response.status, 404);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'full_podcast.mp3'), 'utf8'), 'unpublished');
    if (id === 'invalid_meta') assert.equal(fs.readFileSync(meta, 'utf8'), '{broken');
    else assert.equal(fs.existsSync(meta), false);
  }

  // Also test a legacy manager wrapper (without *ReadOnly methods) and ?download=1: must not trigger recovery.
  const legacyManager = { listPodcasts: () => manager.listPodcasts(), getPodcast: id => manager.getPodcast(id) };
  const svcLegacy = createLanCompanion({
    manager: legacyManager, collectionStore, publicDir: path.join(__dirname, '../public'), podcastsDir,
    bindHost: '127.0.0.1', getLanInterfaces: hosts,
  });
  t.after(() => svcLegacy.stop());
  const legacyLive = await svcLegacy.start();
  const legacyCookie = await pair(legacyLive.port, legacyLive.url);
  await assertPublication(legacyLive.port, legacyCookie, pendingMeta);
  fs.writeFileSync(metaFile, committedMeta);
  await assertPublication(port, cookie, committedMeta);
  await assertPublication(legacyLive.port, legacyCookie, committedMeta);

  // Even when meta.json is missing while .tmp-publish-* exists, legacyManager must not trigger recovery.
  fs.unlinkSync(metaFile);
  await assertPublication(legacyLive.port, legacyCookie, undefined);
  fs.writeFileSync(metaFile, pendingMeta);
  await svcLegacy.stop();

  // Test createApp().listen() direct startup: mobile GETs must not create/delete .server.lock or .server-start-* in dataDir.
  const app = createApp({ dataDir, podcastsDir, publicDir: path.join(__dirname, '../public'), getLanInterfaces: loopbackHosts });
  const appServer = app.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  t.after(async () => {
    await app.shutdown();
    await new Promise(resolve => appServer.close(resolve));
  });
  const startRes = await fetch('http://127.0.0.1:' + appServer.address().port + '/api/lan-companion/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const started = (await startRes.json()).data;
  const appCookie = await pair(started.port, started.url);
  // Recreate pending transaction after main-server /start initialized its taskManager.
  fs.writeFileSync(metaFile, pendingMeta);
  fs.writeFileSync(path.join(epDir, 'full_podcast.mp3'), 'new-audio');
  fs.mkdirSync(origDir2, { recursive: true });
  fs.writeFileSync(path.join(origDir2, 'full_podcast.mp3'), origMp3);
  fs.writeFileSync(path.join(origDir2, 'meta.json'), origMeta);
  fs.writeFileSync(path.join(txDir2, 'prepared'), preparedBytes);
  const realDataDir = fs.realpathSync(dataDir);
  const isDataDirPath = target => {
    const p = String(target);
    return p.startsWith(dataDir) || p.startsWith(realDataDir);
  };
  const lockEvents = [];
  const origWrite = fs.writeFileSync;
  const origOpen = fs.openSync;
  const writeMock = t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (isDataDirPath(file)) lockEvents.push(String(file));
    return origWrite.call(fs, file, ...rest);
  });
  const openMock = t.mock.method(fs, 'openSync', (file, ...rest) => {
    if (isDataDirPath(file)) lockEvents.push(String(file));
    return origOpen.call(fs, file, ...rest);
  });
  try {
    await assertPublication(started.port, appCookie, pendingMeta);
  } finally {
    writeMock.mock.restore();
    openMock.mock.restore();
  }
  assert.deepEqual(lockEvents, []);

  // Client does NOT destroy socket on CONNECT; server must destroy it and stop() must resolve promptly.
  const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'localhost:80' });
  const connected = once(req, 'connect');
  req.end();
  const [res, socket] = await connected;
  assert.equal(res.statusCode, 405);
  await once(socket, 'close');
  await svc.stop();
  await assertReleased(port);
});
