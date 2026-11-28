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
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { execFileSync } = require('node:child_process');
const { applicationFiles, verifyBundle, verifyTarget, locate } = require('../scripts/verify-desktop-bundle');
const root = path.resolve(__dirname, '..');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkcast-desktop-'));
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
  const origin = 'inkcast://app', external = 'https://example.org/path';
  const contents = new EventEmitter(), opened = [];
  contents.setWindowOpenHandler = fn => { contents.popup = fn; };
  guardNavigation(contents, origin, url => opened.push(url));
  assert.equal(classify(origin + '/', origin), 'local');
  assert.equal(classify('http://127.0.0.1:3458'), 'external');
  assert.equal(classify('http://127.0.0.1:3458', 'http://127.0.0.1:3458'), 'local');
  for (const url of ['inkcast://elsewhere', 'inkcast://app:8888', 'inkcast://user@app']) {
    assert.equal(classify(url), 'deny');
  }
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
  write(dir, id + '/full_podcast.mp3', makeMp3(4));
  write(dir, id + '/sentence_001.mp3', makeMp3(2));
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
  assert.deepEqual(result, { sourcePodcastsDir: await fs.promises.realpath(podcasts), importedCount: 2, skippedCount: 1, invalidCount: 3 });
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

test('拒绝伪造整期 MP3 或截断分句并清理暂存目录', async t => {
  const dir = scratch(t), source = path.join(dir, 'podcasts'), target = path.join(dir, 'out');
  podcast(source, 'fake');
  podcast(source, 'partial');
  write(source, 'fake/full_podcast.mp3', 'fake MP3');
  write(source, 'partial/sentence_001.mp3', makeMp3(2).subarray(0, -1));
  const result = await importLegacyPodcasts(source, target);
  assert.deepEqual([result.invalidCount, result.importedCount], [2, 0]);
  assert.deepEqual(fs.readdirSync(target), []);
});

const fixture = Object.fromEntries(Array.from(applicationFiles, name => [name, 'content']));

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

function macRuntime(app) {
  write(app, 'Contents/Info.plist', '<plist version="1.0"><dict/></plist>');
  write(app, 'Contents/MacOS/拾声集', 'fixture');
  write(app, 'Contents/PkgInfo', 'APPL????');
  fs.mkdirSync(path.join(app, 'Contents/Frameworks'));
}

function installedResources(dir) {
  write(dir, 'app.asar', asar(fixture));
  write(dir, 'public/podcasts/.gitkeep', '');
}

test('完整 macOS 应用拒绝游离条目、禁运文件和 plist 中的本机路径与凭据', t => {
  const app = path.join(scratch(t), '拾声集.app');
  macRuntime(app);
  installedResources(path.join(app, 'Contents/Resources'));
  assert.deepEqual(verifyTarget(app), [applicationFiles.size]);
  for (const name of ['leak.txt', 'Contents/leak.txt', 'Contents/MacOS/.env', 'Contents/Frameworks/stray.map',
    'Contents/_CodeSignature/AGENTS.md']) {
    write(app, name, 'extra');
    assert.throws(() => verifyTarget(app), /白名单以外/);
    fs.unlinkSync(path.join(app, name));
  }
  for (const [key, value] of [['home', '/Users/fixture/private'], ['apiKey', 'synthetic-fixture']]) {
    write(app, 'Contents/Info.plist', '<plist><dict><key>' + key + '</key><string>' + value + '</string></dict></plist>');
    assert.throws(() => verifyTarget(app), /安全扫描/);
  }
});

function nsisFixture(t) {
  const root = scratch(t), exe = path.join(root, 'setup.exe');
  const outer = path.join(root, 'outer'), inner = path.join(root, 'inner');
  write(root, 'setup.exe', 'offline NSIS fixture');
  write(outer, '$PLUGINSDIR/System.dll', 'plugin');
  write(inner, '拾声集.exe', 'runtime');
  installedResources(path.join(inner, 'resources'));
  // Replace only 7-Zip extraction. Both archive layers use the production verifier.
  t.mock.method(require('node:child_process'), 'execFileSync', (command, args) => {
    assert.equal(command, '7z');
    const isOuter = args[1] === '-tNsis';
    assert.equal(args[1], isOuter ? '-tNsis' : '-t7z');
    if (isOuter) assert.ok(args.at(-1).endsWith('setup.exe'));
    else assert.equal(path.basename(args.at(-1)), 'app-64.7z');
    fs.cpSync(isOuter ? outer : inner, args.find(arg => arg.startsWith('-o')).slice(2), { recursive: true });
  });
  return { exe, outer, inner };
}

test('NSIS 即使外层含合法资源也必须有内层归档', t => {
  const { exe, outer } = nsisFixture(t);
  installedResources(path.join(outer, 'resources'));
  assert.throws(() => verifyTarget(exe), /必须包含唯一的内层安装负载/);
});

test('NSIS 检查外层插件、内层运行时及 locales 中的所有条目', t => {
  const { exe, outer, inner } = nsisFixture(t);
  write(outer, '$PLUGINSDIR/app-64.7z', 'fixture payload');
  write(outer, '$R0/Uninstall 拾声集.exe', 'fixture uninstaller');
  write(inner, 'electron_wer.dll', 'fixture runtime');
  write(inner, 'dxcompiler.dll', 'fixture runtime');
  write(inner, 'locales/zh-CN.pak', 'fixture locale');
  assert.deepEqual(verifyTarget(exe), [applicationFiles.size]);
  for (const [dir, name] of [[outer, 'stray.txt'], [outer, '$PLUGINSDIR/private.dll'],
    [outer, '$R0/stray.exe'],
    [inner, 'stray.dll'], [inner, 'stray.txt'], [inner, 'stray.js'], [inner, '.env'],
    [inner, 'dxil.dll'], [inner, 'libEGL.dll'], [inner, 'libGLESv2.dll'], [inner, 'locales/private.txt']]) {
    write(dir, name, 'extra');
    assert.throws(() => verifyTarget(exe), { message: '运行时含白名单以外的条目或链接：' + name });
    fs.unlinkSync(path.join(dir, name));
  }
  fs.mkdirSync(path.join(outer, '$R0/nested'));
  assert.throws(() => verifyTarget(exe), { message: '运行时含白名单以外的条目或链接：$R0/nested' });
  fs.rmdirSync(path.join(outer, '$R0/nested'));
  fs.renameSync(path.join(outer, '$PLUGINSDIR/app-64.7z'), path.join(outer, '$PLUGINSDIR/app-arm64.7z'));
  const x64Exe = path.join(path.dirname(exe), 'InkCast-v1.0.0-win-x64-setup.exe');
  fs.renameSync(exe, x64Exe);
  assert.throws(() => verifyTarget(x64Exe), /负载架构不匹配/);
});

test('同时发现两种平台产物；正常 ASAR 与展开目录通过，禁运内容与损坏归档被拦截', t => {
  const dir = scratch(t);
  const app = path.join(dir, 'mac-arm64/拾声集.app/Contents/Resources/app');
  for (const [name, bytes] of Object.entries(fixture)) write(app, name, bytes);
  macRuntime(path.join(dir, 'mac-arm64/拾声集.app'));
  write(dir, 'win-unpacked/拾声集.exe', 'fixture');
  const file = path.join(dir, 'win-unpacked/resources/app.asar');
  write(dir, path.relative(dir, file), asar(fixture));
  for (const resources of [path.dirname(app), path.dirname(file)]) write(resources, 'public/podcasts/.gitkeep', '');
  assert.deepEqual(locate(dir).sort(), [app, file].sort());
  for (const target of locate(dir)) assert.equal(verifyBundle(target), Object.keys(fixture).length);
  for (const name of ['plan/notes', '.env', 'AGENTS.md', 'data/tasks/x', 'public/podcasts/id/meta.json',
    'electron/extra.js', 'public/stray.js', 'src/services/stray.js', 'src/.git/HEAD', 'src/a.map', 'node_modules/electron/index.js', 'src/../private']) {
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
  write(file + '.unpacked', 'src/services/stray', 'extra');
  fs.writeFileSync(file, asar(fixture));
  assert.throws(() => verifyBundle(file), /未登记/);
});

test('已锁定的生产依赖仍须排除开发文件，外置播客目录必须只有空占位符', t => {
  const dir = scratch(t), resources = path.join(dir, 'resources'), file = path.join(resources, 'app.asar');
  const manifest = 'node_modules/express/package.json';
  const version = require('../package-lock.json').packages['node_modules/express'].version;
  const valid = { ...fixture, [manifest]: JSON.stringify({ name: 'express', version }) };
  write(resources, 'app.asar', asar(valid));
  assert.equal(verifyBundle(file), Object.keys(valid).length);
  for (const name of ['a.map', 'test/index.js', 'tests.js', 'eslint.config.mjs', 'yarn.lock', 'notes.md', '.DS_Store']) {
    fs.writeFileSync(file, asar({ ...valid, ['node_modules/express/' + name]: 'extra' }));
    assert.throws(() => verifyBundle(file), /禁运/);
  }
  fs.writeFileSync(file, asar({ ...valid, [manifest]: JSON.stringify({ name: 'express', version: '0.0.0' }) }));
  assert.throws(() => verifyBundle(file), /非生产依赖/);
  assert.throws(() => locate(resources), /占位文件/);
  write(resources, 'public/podcasts/.gitkeep', 'not empty');
  assert.throws(() => locate(resources), /占位文件/);
  write(resources, 'public/podcasts/.gitkeep', '');
  write(resources, 'public/podcasts/stray.mp3', 'extra');
  assert.throws(() => locate(resources), /白名单/);
});

test('桌面运行环境仅用于开发构建，版本、许可证与双端发布契约一致', () => {
  const pkg = require('../package.json'), lock = require('../package-lock.json');
  assert.equal(pkg.version, '1.1.0');
  assert.equal(pkg.version, lock.version);
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
  assert.match(read('TRADEMARK.md'), /拾声集[\s\S]*图标/);
  assert.ok(applicationFiles.has('public/icon.png'));
  const builder = read('electron-builder.yml');
  for (const value of ['appId: com.inkcast.desktop', 'productName: 拾声集',
    'artifactName: InkCast-v${version}-mac-${arch}.dmg', 'artifactName: InkCast-v${version}-win-${arch}-setup.exe']) {
    assert.ok(builder.includes(value), value);
  }
  const workflow = read('.github/workflows/release.yml');
  for (const part of ['needs: [portable, desktop-mac, desktop-win]', 'name: inkcast-release',
    'dist/InkCast-v*-mac-*.dmg', 'dist/InkCast-v*-win-*-setup.exe', 'dist/InkCast-v*-portable.zip',
    'dist/InkCast-v*-portable.tar.gz', 'sha256sum -c', 'action-gh-release@v2']) {
    assert.ok(workflow.includes(part), part);
  }
});

test('桌面源文件白名单与受追踪的服务文件一致', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/services/*.js'], { cwd: root, encoding: 'utf8' });
  assert.deepEqual([...applicationFiles].filter(name => name.startsWith('src/services/')).sort(), tracked.split('\0').filter(Boolean).sort());
});
