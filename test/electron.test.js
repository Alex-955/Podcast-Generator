'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadWindowState, saveWindowState } = require('../electron/windowState');
const { classify, guardNavigation, allowDownload } = require('../electron/navigationGuard');
const { importLegacyPodcasts } = require('../electron/migration');
const { verifyBundle, locate } = require('../scripts/verify-desktop-bundle');
const root = path.resolve(__dirname, '..');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoting-desktop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('窗口默认居中、记录副屏负坐标、拔下副屏后完整可见，损坏状态可恢复', t => {
  const dir = scratch(t);
  const primary = { x: 0, y: 24, width: 1440, height: 900 };
  const secondary = { x: -1920, y: -50, width: 1920, height: 1080 };
  const defaults = { x: 80, y: 54, width: 1280, height: 840 };
  assert.deepEqual(loadWindowState(dir, [primary]), defaults);
  const saved = { x: -1930, y: -40, width: 1000, height: 700 };
  saveWindowState(dir, saved);
  assert.deepEqual(loadWindowState(dir, [primary, secondary]), { ...saved, x: -1920 });
  assert.deepEqual(loadWindowState(dir, [primary]), { x: 220, y: 124, width: 1000, height: 700 });
  const small = { x: -100, y: 10, width: 800, height: 500 };
  assert.deepEqual(loadWindowState(dir, [small]), small);
  fs.writeFileSync(path.join(dir, 'window-state.json'), '{');
  assert.deepEqual(loadWindowState(dir, [primary]), defaults);
  assert.deepEqual(fs.readdirSync(dir), ['window-state.json']);
});

test('守卫阻止站外导航、重定向与子窗口，外部网页交系统浏览器，下载限本机音频', () => {
  const origin = 'http://127.0.0.1:3458', external = 'https://example.org/path';
  const contents = new EventEmitter(), opened = [];
  contents.setWindowOpenHandler = fn => { contents.popup = fn; };
  guardNavigation(contents, origin, url => opened.push(url));
  assert.equal(classify(origin + '/', origin), 'local');
  assert.equal(classify(origin.replace('3458', '3459'), origin), 'external');
  for (const type of ['will-frame-navigate', 'will-redirect']) {
    for (const [url, blocked] of [[origin, false], [external, true], ['file:///invalid', true]]) {
      let prevented = false;
      contents.emit(type, { url, isMainFrame: true, preventDefault() { prevented = true; } });
      assert.equal(prevented, blocked);
    }
  }
  for (const url of [external, origin, 'javascript:void(0)', 'data:text/plain,hi', 'blob:' + origin,
    'https://user:pwd@example.org/', 'file:///invalid', 'malformed']) {
    assert.deepEqual(contents.popup({ url }), { action: 'deny' });
    if (![origin, external].includes(url)) assert.equal(classify(url, origin), 'deny');
  }
  assert.deepEqual(opened, [external, external, external]);
  const audio = origin + '/podcasts/ep-1/full_podcast.mp3?v=1';
  assert.ok(allowDownload([audio], origin));
  for (const chain of [[], [audio, external], [external, audio], [origin + '/api/tasks']]) assert.ok(!allowDownload(chain, origin));
});

function write(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function podcast(dir, id) {
  write(dir, id + '/full_podcast.mp3', 'fixture-audio');
  write(dir, id + '/sentence_001.mp3', 'fixture-sentence');
  write(dir, id + '/meta.json', '{"podcastTitle":"fixture"}');
}

test('便携导入兼容两种入口，保留既有目标和源文件，忽略非法或不完整的节目', async t => {
  const dir = scratch(t), source = path.join(dir, 'legacy'), target = path.join(dir, 'target');
  const podcasts = path.join(source, 'public/podcasts');
  for (const id of ['first', 'existing', 'not valid', 'empty', 'broken', 'private']) podcast(podcasts, id);
  write(podcasts, 'empty/full_podcast.mp3', '');
  write(podcasts, 'broken/meta.json', '{');
  write(podcasts, 'private/meta.json', '{"apiKey":"private-fixture","summary":"private-fixture"}');
  write(podcasts, 'first/other.mp3', 'omit');
  write(target, 'existing/keep', 'original');
  const snapshot = () => fs.readdirSync(source, { recursive: true }).sort().map(name => {
    const file = path.join(source, name);
    return [name, fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'hex') : null];
  });
  const before = snapshot();
  const result = await importLegacyPodcasts(source, target);
  assert.deepEqual(result, { sourcePodcastsDir: fs.realpathSync(podcasts), importedCount: 2, skippedCount: 1, invalidCount: 3 });
  assert.deepEqual(fs.readdirSync(path.join(target, 'first')).sort(), ['full_podcast.mp3', 'meta.json', 'sentence_001.mp3']);
  assert.deepEqual(fs.readdirSync(path.join(target, 'existing')), ['keep']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'private/meta.json'))), { summary: '***' });
  assert.equal((await importLegacyPodcasts(podcasts, target)).skippedCount, 3);
  await assert.rejects(importLegacyPodcasts(podcasts, path.join(podcasts, 'new')), /重叠/);
  assert.deepEqual(snapshot(), before);
});

test('迁移拒绝链接目录、链接音频以及链接元数据', async t => {
  const dir = scratch(t), podcasts = path.join(dir, 'podcasts'), target = path.join(dir, 'out');
  for (const id of ['valid', 'linked']) podcast(podcasts, id);
  fs.symlinkSync(path.join(podcasts, 'valid'), path.join(podcasts, 'alias'), 'junction');
  try {
    fs.symlinkSync(path.join(podcasts, 'valid/full_podcast.mp3'), path.join(podcasts, 'valid/sentence_link.mp3'), 'file');
    fs.unlinkSync(path.join(podcasts, 'linked/meta.json'));
    fs.symlinkSync(path.join(podcasts, 'valid/meta.json'), path.join(podcasts, 'linked/meta.json'), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    fs.rmSync(path.join(podcasts, 'linked/meta.json'), { force: true });
  }
  const result = await importLegacyPodcasts(podcasts, target);
  assert.equal(result.importedCount, 1);
  assert.equal(result.invalidCount, 2);
  assert.ok(!fs.existsSync(path.join(target, 'valid/sentence_link.mp3')));
});

const fixture = Object.fromEntries(['electron/main.js', 'electron/preload.js', 'server.js', 'package.json',
  'public/index.html', 'LICENSE', 'TRADEMARK.md'].map(name => [name, 'content']));

function asar(files) {
  const tree = { files: {} }, data = [];
  let position = 0;
  for (const [name, content] of Object.entries(files)) {
    const parts = name.split('/'), leaf = parts.pop();
    let dir = tree;
    for (const part of parts) dir = dir.files[part] ??= { files: {} };
    const bytes = Buffer.from(content);
    dir.files[leaf] = { offset: String(position), size: bytes.length };
    position += bytes.length;
    data.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(tree)), header = Buffer.alloc(16 + Math.ceil(json.length / 4) * 4);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(header.length - 8, 4);
  header.writeUInt32LE(header.length - 12, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...data]);
}

test('同时发现两种平台产物；正常 ASAR 与展开目录通过，禁运内容与损坏归档被拦截', t => {
  const dir = scratch(t);
  const app = path.join(dir, 'mac-arm64/AI 妙听.app/Contents/Resources/app');
  for (const [name, bytes] of Object.entries(fixture)) write(app, name, bytes);
  const file = path.join(dir, 'win-unpacked/resources/app.asar');
  write(dir, path.relative(dir, file), asar(fixture));
  assert.deepEqual(locate(dir).sort(), [app, file].sort());
  for (const target of locate(dir)) assert.equal(verifyBundle(target), Object.keys(fixture).length);
  for (const name of ['plan/notes', '.env', 'AGENTS.md', 'data/tasks/x', 'public/podcasts/id/meta.json',
    'src/.git/HEAD', 'src/a.map', 'node_modules/electron/index.js', 'src/../private']) {
    fs.writeFileSync(file, asar({ ...fixture, [name]: 'fixture' }));
    assert.throws(() => verifyBundle(file));
  }
  for (const content of ['sk-' + 'X'.repeat(25), '/Us' + 'ers/fixture/private file',
    'C:' + '\\Users\\fixture\\private', '-----BEGIN ' + 'PRIVATE KEY-----', 'apiKey: "synthetic-example"',
    Buffer.concat([Buffer.from([0xff]), Buffer.from(' sk-' + 'Z'.repeat(30))])]) {
    fs.writeFileSync(file, asar({ ...fixture, 'server.js': content }));
    assert.throws(() => verifyBundle(file), /安全扫描/);
  }
  for (const bytes of [asar(fixture).subarray(0, -1), Buffer.concat([asar(fixture), Buffer.of(0)]), asar({})]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => verifyBundle(file));
  }
  write(file + '.unpacked', 'src/stray', 'extra');
  fs.writeFileSync(file, asar(fixture));
  assert.throws(() => verifyBundle(file), /未登记/);
});

test('桌面运行环境仅用于开发构建，版本、许可证与双端发布契约一致', () => {
  const pkg = require('../package.json'), lock = require('../package-lock.json');
  assert.equal(pkg.version, '1.0.0');
  assert.equal(pkg.license, 'GPL-3.0-only');
  assert.equal(pkg.main, 'electron/main.js');
  assert.equal(pkg.version, lock.packages[''].version);
  assert.equal(pkg.license, lock.packages[''].license);
  for (const name of ['electron', 'electron-builder']) {
    assert.ok(pkg.devDependencies[name]);
    assert.equal(pkg.dependencies[name], undefined);
    assert.equal(lock.packages['node_modules/' + name].dev, true);
  }
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  assert.match(read('LICENSE'), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.equal(createHash('sha256').update(read('LICENSE').replace(/\r\n/g, '\n')).digest('hex'),
    '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986');
  assert.match(read('TRADEMARK.md'), /AI 妙听[\s\S]*图标/);
  const workflow = read('.github/workflows/release.yml');
  for (const part of ['needs: [portable, desktop-mac, desktop-win]', 'dist/*.dmg', 'dist/*.exe', 'sha256sum -c', 'action-gh-release@v2']) {
    assert.ok(workflow.includes(part), part);
  }
});
