'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { gunzipSync, inflateRawSync } = require('node:zlib');
const { buildRelease, runReleaseSecurityGate, parseArgs } = require('../scripts/build-release');
const { version } = require('../package.json');

const PROJECT = path.resolve(__dirname, '..');
const SOURCE_FILES = [
  'server.js', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', '.env.example', 'src',
  'scripts/start-portable.js', 'scripts/build-mac-launcher.sh',
  'scripts/launchers/macos.command', 'scripts/launchers/windows.bat',
  ...['index.html', 'style.css', 'app.js', 'inputSource.js', 'audioEngine.js'].map(file => 'public/' + file),
];
const INTERNAL_FILES = ['ROADMAP.md', 'Plan.md', 'AGENTS.md', 'plan/draft.md', 'website/index.html'];
const PRIVATE_FILES = [
  '.env', '.env.local', '.git/config', '.DS_Store', 'server.log', 'data/server.pid', 'data/tasks/1.json',
  'data/tts-cache/cache.mp3', 'public/podcasts/secret-ep/full_podcast.mp3',
  'AI 妙听.app/Contents/sample', '启动 AI 妙听.app/Contents/sample',
  'test/private-fixture.js', 'src/private-notes.txt', 'public/private.html',
  ...INTERNAL_FILES,
];
const ROOT_LAUNCHERS = ['AI 妙听.bat', 'AI 妙听.command'];

async function removeDirWithBudget(target, { budgetMs = 8000, delayMs = 150 } = {}) {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    try {
      await fsPromises.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || !['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE'].includes(error.code)) throw error;
      await delay(Math.min(delayMs, remaining));
      if (performance.now() >= deadline) throw error;
    }
  }
}

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast release '));
  t.after(() => removeDirWithBudget(directory));
  return directory;
}

function write(base, relative, contents) {
  const target = path.join(base, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function sourceFixture(root) {
  const source = path.join(root, 'source');
  for (const file of SOURCE_FILES) {
    const to = path.join(source, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(path.join(PROJECT, file), to, { recursive: true });
  }
  for (const file of PRIVATE_FILES) write(source, file, 'offline private test fixture');
  write(source, 'public/podcasts/.gitkeep', 'not the shipped empty placeholder');
  write(source, 'data/.gitkeep', 'not the shipped empty placeholder');
  return source;
}

async function verifyStagedServer(stageDir, tmpDir, { nodePath = '' } = {}) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: stageDir, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_PATH: nodePath, CI: 'true', HOST: '127.0.0.1', PORT: '0',
      DATA_DIR: path.join(tmpDir, 'runtime-data'), PODCASTS_DIR: path.join(tmpDir, 'runtime-audio'),
    },
  });
  const finished = once(server, 'close');
  let stdout = '';
  let stderr = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', chunk => { stderr += chunk; });
  let ready;
  try {
    ready = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('exit', code => reject(new Error('暂存服务退出 ' + code + '\n' + stderr)));
      const timeout = setTimeout(() => reject(new Error('暂存服务启动超时')), 10000);
      timeout.unref();
      finished.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
      server.stdout.setEncoding('utf8');
      server.stdout.on('data', chunk => {
        stdout += chunk;
        const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (url) {
          clearTimeout(timeout);
          resolve(url[0]);
        }
      });
    });
    const health = await fetch(ready + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).version, version);
    const html = await fetch(ready + '/');
    assert.equal(html.status, 200);
    assert.match(await html.text(), /AI 妙听/);
  } finally {
    server.kill();
    await finished;
  }
  assert.equal(runReleaseSecurityGate(stageDir), true, '启动时只应写入隔离目录');
}

function zipEntries(archive, extractDir) {
  const zip = fs.readFileSync(archive);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP 应包含中央目录结束记录');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const length = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 46, offset + 46 + length).toString('utf8');
    const local = zip.readUInt32LE(offset + 42);
    const attributes = zip.readUInt32LE(offset + 38);
    assert.equal(zip.readUInt16LE(offset + 4), 0x031e);
    assert.equal(zip.readUInt16LE(offset + 6), 20);
    assert.equal(zip.readUInt16LE(offset + 8), 0x0800, name);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 4), 20);
    assert.equal(zip.readUInt16LE(local + 6), 0x0800, name);
    assert.equal(zip.readUInt16LE(local + 26), length);
    assert.equal(zip.subarray(local + 30, local + 30 + length).toString('utf8'), name);
    const method = zip.readUInt32LE(offset + 24) ? 8 : 0;
    assert.equal(zip.readUInt16LE(offset + 10), method);
    assert.equal(zip.readUInt16LE(local + 8), method);
    if (name.endsWith('/')) assert.equal(attributes, ((0o040755 << 16) | 0x10) >>> 0);
    if (extractDir && !name.endsWith('/')) {
      assert.ok(name.split('/').every(part => part && part !== '..' && !/[\\:]/.test(part)));
      const start = local + 30 + length + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + zip.readUInt32LE(offset + 20));
      write(extractDir, name, method ? inflateRawSync(data) : data);
    }
    entries.set(name, attributes >>> 16);
    offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return entries;
}

function tarEntries(archive) {
  const bytes = gunzipSync(fs.readFileSync(archive));
  const entries = new Map();
  let offset = 0;
  let paxName;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    assert.equal(header.length, 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.toString('ascii', start, end).split('\0', 1)[0];
    assert.equal(header.toString('ascii', 257, 265), 'ustar\0' + '00');
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);
    assert.equal(parseInt(field(148, 156), 8), checksum);
    const size = parseInt(field(124, 136), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length);
    const contents = bytes.subarray(offset + 512, offset + 512 + size);
    assert.ok(header.subarray(0, 100).every(byte => byte < 128), 'USTAR 回退名称应为 ASCII');
    const type = header.toString('ascii', 156, 157);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      assert.equal(paxName, undefined);
      const separator = contents.indexOf(0x20);
      assert.ok(separator > 0);
      assert.equal(contents.toString('ascii', 0, separator), String(contents.length));
      assert.equal(contents.toString('ascii', separator + 1, separator + 6), 'path=');
      assert.equal(contents.at(-1), 0x0a);
      paxName = contents.toString('utf8', separator + 6, contents.length - 1);
      continue;
    }
    const name = paxName ?? field(0, 100);
    assert.equal(type, name.endsWith('/') ? '5' : '0');
    assert.equal(entries.has(name), false, name);
    entries.set(name, { mode: parseInt(field(100, 108), 8), pax: paxName !== undefined, contents });
    paxName = undefined;
  }
  assert.equal(paxName, undefined);
  assert.deepEqual(bytes.subarray(offset), Buffer.alloc(1024));
  return entries;
}

test('发行参数校验阻止未知格式、无效名称和路径穿越', t => {
  assert.deepEqual(parseArgs(['--out-dir', 'build', '--name', 'demo', '--format', 'both', '--with-deps',
    '--source-dir', 'source']), {
    outDir: 'build', name: 'demo', format: 'both', withDeps: true, sourceDir: 'source',
  });
  assert.throws(() => parseArgs(['--format', 'rar']), /--format/);
  assert.throws(() => parseArgs(['--name', '--with-deps']), /缺少 --name/);
  assert.throws(() => parseArgs(['--extra']), /无法识别/);
  const outDir = scratch(t);
  for (const name of ['../outside', 'a/b', 'a\\b', '.git', 'CON', 'bad.']) {
    assert.throws(() => buildRelease({ name, outDir, format: 'dir' }), /单个目录名/);
  }
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('发行输出不得位于源码根、复制子树或指向复制子树的符号链接内', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  for (const dir of ['src', 'public', 'scripts', 'node_modules']) {
    const outDir = path.join(sourceDir, dir, 'new-output', 'child');
    assert.throws(() => buildRelease({ sourceDir, outDir, format: 'dir', withDeps: true }), /发行输出目录不能/);
    assert.ok(!fs.existsSync(path.dirname(outDir)));
  }
  assert.throws(() => buildRelease({ sourceDir, outDir: sourceDir, format: 'dir' }), /发行输出目录不能/);
  const alias = path.join(root, 'output-alias');
  fs.symlinkSync(path.join(sourceDir, 'src'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const outDir = path.join(alias, 'new-output');
  assert.throws(() => buildRelease({ sourceDir, outDir, format: 'dir' }), /发行输出目录不能/);
  assert.ok(!fs.existsSync(outDir));
});

test('大小写不敏感的文件系统会拦截 SRC 输出别名且不创建目录', t => {
  const sourceDir = sourceFixture(scratch(t));
  const alias = path.join(sourceDir, 'SRC');
  if (!fs.existsSync(alias)) return t.skip('临时目录位于大小写敏感的文件系统');
  for (const outDir of [path.join(alias, 'new-output'), path.join(alias, 'services', 'new-output')]) {
    assert.throws(() => buildRelease({ sourceDir, outDir, format: 'dir' }), /发行输出目录不能/);
    assert.equal(fs.existsSync(outDir), false);
  }
});

test('SHA256 清单保留其他现有归档，过滤失效条目并按文件名排序', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  const outDir = path.join(root, 'out');
  const original = buildRelease({ sourceDir, outDir, name: 'zeta' });
  const oldEntry = fs.readFileSync(original.checksumFile, 'utf8');
  const stale = 'a'.repeat(64);
  write(root, 'outside.zip', 'test fixture');
  fs.appendFileSync(original.checksumFile, [
    stale + '  ../outside.zip', stale + '  missing.zip', 'not-a-digest  zeta.zip', stale + '  alpha.zip', '',
  ].join('\n'));
  const second = buildRelease({ sourceDir, outDir, name: 'alpha' });
  const digest = createHash('sha256').update(fs.readFileSync(second.archives[0])).digest('hex');
  assert.equal(fs.readFileSync(second.checksumFile, 'utf8'), digest + '  alpha.zip\n' + oldEntry);
});

test('白名单从混有个人数据的源码生成干净目录，暂存服务离线返回健康和首页', async t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  const { stageDir, archives, checksumFile } = buildRelease({
    sourceDir, outDir: path.join(root, 'out'), format: 'dir',
  });
  assert.equal(path.basename(stageDir), 'ai-podcast-generator-v' + version + '-portable');
  assert.deepEqual(archives, []);
  assert.equal(checksumFile, null);
  for (const file of PRIVATE_FILES) {
    assert.equal(fs.existsSync(path.join(stageDir, file)), false, file);
    assert.equal(fs.existsSync(path.join(sourceDir, file)), true, file);
  }
  assert.deepEqual(fs.readdirSync(path.join(stageDir, 'data')), ['.gitkeep']);
  assert.deepEqual(fs.readdirSync(path.join(stageDir, 'public/podcasts')), ['.gitkeep']);
  assert.equal(fs.statSync(path.join(stageDir, 'public/podcasts/.gitkeep')).size, 0);
  assert.equal(fs.statSync(path.join(stageDir, 'data/.gitkeep')).size, 0);
  for (const file of ['LICENSE', '.env.example']) {
    assert.ok(fs.existsSync(path.join(stageDir, file)), file);
  }
  assert.deepEqual(fs.readdirSync(stageDir).filter(file => /\.(bat|command)$/.test(file)).sort(), ROOT_LAUNCHERS);
  assert.equal(fs.existsSync(path.join(stageDir, 'node_modules')), false);
  await verifyStagedServer(stageDir, root, { nodePath: path.join(PROJECT, 'node_modules') });
});

test('发行门禁识别禁运路径、个人主目录、私钥和 API 密钥，同时避免打印凭据', t => {
  const root = scratch(t);
  const { stageDir } = buildRelease({ sourceDir: sourceFixture(root), outDir: path.join(root, 'out'), format: 'dir' });
  assert.equal(runReleaseSecurityGate(stageDir), true);
  const key = 'sk-' + 'A'.repeat(30);
  write(stageDir, '.env', 'Offline sample');
  write(stageDir, 'data/tasks/notes.txt', 'non-JSON private data');
  write(stageDir, 'data/notes.txt', 'unexpected private data');
  write(stageDir, '.env.example', '# EXAMPLE_SECRET=commented\nVOLCENGINE_TTS_ACCESS_KEY=abc\n');
  write(stageDir, 'public/podcasts/unexpected.mp3', Buffer.from([0xff, 0x00, 0x05]));
  write(stageDir, 'AI 妙听.app/Contents/sample', 'local app fixture');
  write(stageDir, '启动 AI 妙听.app/Contents/sample', 'legacy local app fixture');
  write(stageDir, 'src/path.js', 'const path = "/Users/alice";\n');
  write(stageDir, 'src/linuxHome.js', 'const home = "/home/alice";\n');
  write(stageDir, 'src/windowsHome.js', 'const home = "c:\\\\users\\\\alice";\n');
  write(stageDir, 'src/windowsPath.js', 'const path = "C:\\\\Users\\\\Offline User\\\\stuff";\n');
  write(stageDir, 'src/routes.js', 'const route = "/users/delete";\n');
  write(stageDir, 'src/key.js', 'const secret = "' + key + '";\n');
  write(stageDir, 'src/privateKey.js', '-----BEGIN OPENSSH PRIVATE KEY-----\n');
  write(stageDir, 'node_modules/pkg/key.pem', '-----BEGIN PRIVATE KEY-----\n');
  for (const file of INTERNAL_FILES) write(stageDir, file, 'offline internal fixture');
  for (const file of ['AI 妙听.bat', 'scripts/launchers/windows.bat']) write(stageDir, file, '@echo off\n');
  for (const file of ['AI 妙听.command', 'scripts/launchers/macos.command']) write(stageDir, file, '#!/bin/bash\r\n');
  fs.unlinkSync(path.join(stageDir, 'LICENSE'));

  assert.throws(() => runReleaseSecurityGate(stageDir), error => {
    for (const file of ['AI 妙听.app', '启动 AI 妙听.app', 'ROADMAP.md', 'Plan.md', 'AGENTS.md', 'plan', 'website']) {
      assert.ok(error.issues.includes(file + ' 属于禁运路径'), file);
    }
    for (const detail of ['.env 属于禁运路径', 'data/tasks 属于禁运路径', 'data/notes.txt 属于禁运路径',
      '.env.example:2 凭据字段 VOLCENGINE_TTS_ACCESS_KEY 必须为空', 'node_modules/pkg/key.pem:1 包含私钥头',
      'public/podcasts/unexpected.mp3 属于禁运路径', 'src/path.js:1 包含本机绝对路径',
      'src/linuxHome.js:1 包含本机绝对路径', 'src/windowsHome.js:1 包含本机绝对路径',
      'src/windowsPath.js:1 包含本机绝对路径', 'src/key.js:1 包含疑似 API 密钥',
      'src/privateKey.js:1 包含私钥头', 'AI 妙听.bat 必须使用 CRLF', 'scripts/launchers/windows.bat 必须使用 CRLF',
      'AI 妙听.command 必须使用 LF', 'scripts/launchers/macos.command 必须使用 LF', '缺少必需文件：LICENSE']) {
      assert.ok(error.issues.some(issue => issue.includes(detail)), detail);
    }
    assert.doesNotMatch(error.message, /alice|Offline User|sk-A{30}|=abc|routes\.js|EXAMPLE_SECRET/);
    return true;
  });

  const sourceDir = sourceFixture(root);
  write(sourceDir, 'src/private.js', 'module.exports = "' + key + '";\n');
  const outDir = path.join(root, 'aborted');
  assert.throws(() => buildRelease({ sourceDir, outDir, format: 'both' }), /发行包安全门禁未通过/);
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('发行暂存目录首次 EBUSY 时重试并保留已发布的归档', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  const outDir = path.join(fs.realpathSync.native(root), 'out');
  const rmSync = fs.rmSync;
  let attempts = 0;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.dirname(target) === outDir && path.basename(target).startsWith('.podcast-release-')) {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('offline fixture: busy'), { code: 'EBUSY' });
    }
    return rmSync(target, options);
  });

  const { stageDir, archives, checksumFile } = buildRelease({ sourceDir, outDir, format: 'both' });
  assert.equal(attempts, 2);
  const published = [stageDir, checksumFile, ...archives].map(file => path.basename(file));
  assert.deepEqual(fs.readdirSync(outDir).sort(), published.sort());
});

test('发行暂存目录清理失败时保留安全门禁的原始错误', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  const outDir = path.join(fs.realpathSync.native(root), 'out');
  write(sourceDir, 'src/unsafe.js', '-----BEGIN PRIVATE KEY-----\n');
  const rmSync = fs.rmSync;
  const cleanup = t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.dirname(target) === outDir && path.basename(target).startsWith('.podcast-release-')) {
      throw Object.assign(new Error('offline fixture: access denied'), { code: 'EACCES' });
    }
    return rmSync(target, options);
  });

  assert.throws(() => buildRelease({ sourceDir, outDir, format: 'dir' }), error => {
    assert.match(error.message, /发行包安全门禁未通过/);
    assert.ok(error.issues.includes('src/unsafe.js:1 包含私钥头'));
    return true;
  });
  assert.equal(cleanup.mock.callCount(), 1);
  assert.match(fs.readdirSync(outDir).join('\n'), /^\.podcast-release-\w+$/);
});

test('发行门禁拦截非 ASCII 主目录、dotenv 冒号语法和不合法 UTF-8 模板', t => {
  const root = scratch(t);
  const { stageDir } = buildRelease({ sourceDir: sourceFixture(root), outDir: path.join(root, 'out'), format: 'dir' });
  for (const [file, contents] of [
    ['mac.js', 'const home = "/Users/张三";\n'],
    ['linux.js', 'const home = "/home/测试用户";\n'],
    ['windows.js', 'C:\\Users\\李四\n'],
    ['windowsForward.js', 'C:/Users/李四\n'],
    ['windowsEscaped.js', 'const home = "C:\\\\Users\\\\李四";\n'],
    ['routes.js', 'const route = "/users/delete";\n'],
  ]) write(stageDir, 'src/' + file, contents);
  write(stageDir, '.env.example', 'ADMIN_TOKEN: secret\nADMIN_TOKEN=\nGROUP.ADMIN_TOKEN: secret\n');
  assert.throws(() => runReleaseSecurityGate(stageDir), error => {
    for (const file of ['mac.js', 'linux.js', 'windows.js', 'windowsForward.js', 'windowsEscaped.js']) {
      assert.ok(error.issues.includes('src/' + file + ':1 包含本机绝对路径'), file);
    }
    assert.ok(error.issues.includes('.env.example:1 凭据字段 ADMIN_TOKEN 必须为空'));
    assert.ok(error.issues.includes('.env.example 凭据字段 GROUP.ADMIN_TOKEN 必须为空'));
    assert.doesNotMatch(error.message, /张三|测试用户|李四|routes\.js|secret/);
    return true;
  });
  write(stageDir, '.env.example', Buffer.concat([Buffer.from('ADMIN_TOKEN=secret\n'), Buffer.from([0xff])]));
  assert.throws(() => runReleaseSecurityGate(stageDir), error => {
    assert.ok(error.issues.includes('.env.example 必须是有效的 UTF-8 文本文件'));
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('离线复制依赖时跳过缓存，只允许指向依赖目录内的符号链接', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  write(sourceDir, 'package-lock.json', '{}'); // Legacy fixture without a packages index.
  const packages = path.join(sourceDir, 'node_modules');
  write(packages, 'pkg/package.json', '{}');
  write(packages, 'pkg/.cache/do-not-ship', 'synthetic cached data');
  write(packages, '.bin/pkg.cmd', 'C:\\Users\\alice\\vendor');
  write(packages, 'pkg/README.md', '/Users/alice');
  write(packages, 'pkg/LICENSE.md', 'Fixture license');
  write(packages, 'pkg/index.js', 'module.exports = {};');
  write(root, 'outside/user-data.txt', 'synthetic private data');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  const linkInside = path.join(packages, 'alias');
  fs.symlinkSync(path.join(packages, 'pkg'), linkInside, type);
  const linkOutside = path.join(packages, 'outside');
  fs.symlinkSync(path.join(root, 'outside'), linkOutside, type);
  const outDir = path.join(root, 'out');
  assert.throws(() => buildRelease({ sourceDir, outDir, format: 'dir', withDeps: true }), /符号链接指向 node_modules 之外/);
  assert.deepEqual(fs.readdirSync(outDir), []);
  if (process.platform === 'win32') fs.rmdirSync(linkOutside);
  else fs.unlinkSync(linkOutside);

  const { stageDir } = buildRelease({ sourceDir, outDir, format: 'dir', withDeps: true });
  assert.ok(fs.lstatSync(path.join(stageDir, 'node_modules/alias')).isDirectory());
  assert.equal(fs.readFileSync(path.join(stageDir, 'node_modules/alias/package.json'), 'utf8'), '{}');
  assert.equal(fs.existsSync(path.join(stageDir, 'node_modules/alias/.cache')), false);
  assert.equal(fs.existsSync(path.join(stageDir, 'node_modules/pkg/.cache')), false);
  assert.equal(fs.existsSync(path.join(stageDir, 'node_modules/.bin')), false);
  assert.equal(fs.existsSync(path.join(stageDir, 'node_modules/pkg/README.md')), false);
  assert.equal(fs.existsSync(path.join(stageDir, 'node_modules/pkg/LICENSE.md')), true);
  assert.equal(fs.existsSync(path.join(stageDir, 'node_modules/pkg/index.js')), true);
});

test('复制依赖跳过各层 .DS_Store，门禁仍拦截暂存目录中的同名文件', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  write(sourceDir, 'package-lock.json', JSON.stringify({ packages: { 'node_modules/pkg': {} } }));
  const files = ['node_modules/.DS_Store', 'node_modules/pkg/.dS_sToRe'];
  for (const name of files) write(sourceDir, name, 'synthetic Finder metadata');
  write(sourceDir, 'node_modules/pkg/index.js', 'module.exports = {};');
  const { stageDir } = buildRelease({ sourceDir, outDir: path.join(root, 'out'), format: 'dir', withDeps: true });
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(sourceDir, file)), true);
    assert.equal(fs.existsSync(path.join(stageDir, file)), false);
    write(stageDir, file, 'synthetic Finder metadata');
  }
  assert.throws(() => runReleaseSecurityGate(stageDir),
    error => files.every(file => error.issues.includes(file + ' 属于禁运路径')));
});

test('真实便携 ZIP 和 tar.gz 包含白名单目录、匹配 SHA-256 并带可启动依赖', async t => {
  const root = scratch(t);
  const outDir = path.join(root, 'archives');
  const { stageDir, archives, checksumFile } = buildRelease({ outDir, format: 'both', withDeps: true });
  assert.equal(archives.length, 2);
  const actual = [...archives].sort().map(filename => {
    const bytes = fs.readFileSync(filename);
    assert.ok(bytes.length > 0);
    return createHash('sha256').update(bytes).digest('hex') + '  ' + path.basename(filename);
  });
  assert.equal(fs.readFileSync(checksumFile, 'utf8'), actual.join('\n') + '\n');
  const extracted = path.join(root, 'unzipped');
  const zip = zipEntries(archives[0], extracted);
  for (const entry of zip.keys()) {
    if (!entry.includes('/node_modules/')) continue;
    if (/^(?:licen[cs]e|notice)/i.test(path.posix.basename(entry))) continue;
    assert.doesNotMatch(entry, /\.(?:map|md|markdown)$|\/(?:tests?|__tests__|\.github)\/|\/\.ds_store$/i);
  }
  const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import express from 'express';
    import axios from 'axios';
    import { load } from 'cheerio';
    import cors from 'cors';
    import dotenv from 'dotenv';
    import { v4, validate } from 'uuid';
    import { WebSocketServer } from 'ws';
    assert.equal(typeof express().get, 'function');
    assert.equal(axios.getUri({ url: '/check', params: { q: 1 } }), '/check?q=1');
    assert.equal(load('<p>ok</p>')('p').text(), 'ok');
    assert.equal(typeof cors(), 'function');
    assert.equal(dotenv.parse('X=ok').X, 'ok');
    assert.ok(validate(v4()));
    new WebSocketServer({ noServer: true }).close();
  `], { cwd: path.join(extracted, path.basename(stageDir)), encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.ifError(smoke.error);
  assert.equal(smoke.status, 0, smoke.stderr);
  const tar = tarEntries(archives[1]);
  assert.deepEqual([...tar.keys()].sort(), [...zip.keys()].sort());
  if (process.platform !== 'win32') {
    const listing = spawnSync('tar', ['-tzf', path.basename(archives[1])], {
      cwd: path.dirname(archives[1]), shell: false, encoding: 'utf8',
    });
    assert.ifError(listing.error);
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trimEnd().split(/\r?\n/).sort(), [...tar.keys()].sort());
  }
  const prefix = path.basename(stageDir) + '/';
  for (const file of ['.env.example', 'public/podcasts/.gitkeep', 'data/.gitkeep', 'LICENSE',
    'node_modules/express/package.json']) {
    assert.ok(tar.has(prefix + file), file);
  }
  assert.ok(![...tar.keys()].some(name => name === prefix + '.env' ||
    name.startsWith(prefix + 'public/podcasts/secret') || name.startsWith(prefix + 'test/')));
  for (const launcher of [...ROOT_LAUNCHERS, 'scripts/launchers/windows.bat', 'scripts/launchers/macos.command']) {
    const mode = launcher.endsWith('.command') ? 0o755 : 0o644;
    assert.equal(zip.get(prefix + launcher), 0o100000 | mode, launcher);
    assert.equal(tar.get(prefix + launcher).mode, mode, launcher);
    if (ROOT_LAUNCHERS.includes(launcher)) assert.equal(tar.get(prefix + launcher).pax, true, launcher);
  }
  assert.equal(zip.get(prefix + 'scripts/build-mac-launcher.sh'), 0o100755);
  assert.equal(zip.get(prefix + 'server.js'), 0o100644);
  assert.equal(tar.get(prefix + 'scripts/build-mac-launcher.sh').mode, 0o755);
  assert.equal(tar.get(prefix + 'server.js').mode, 0o644);
  if (spawnSync('python3', ['--version'], { shell: false, windowsHide: true }).status === 0) {
    const verify = [
      'import sys, zipfile', 'with zipfile.ZipFile(sys.argv[1]) as zf:',
      '    assert zf.testzip() is None',
      '    launchers = {name for name in zf.namelist() if name.count("/") == 1 and name.endswith((".bat", ".command"))}',
      '    assert launchers == set(sys.argv[2:])',
    ].join('\n');
    const result = spawnSync('python3', ['-c', verify, archives[0], ...ROOT_LAUNCHERS.map(file => prefix + file)], {
      shell: false, windowsHide: true, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
  await verifyStagedServer(stageDir, root);
});

test('tar.gz 使用 PAX 保留超过 USTAR 名称长度的 ASCII 路径', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  const file = 'src/' + 'long-name-'.repeat(9) + '.js';
  const contents = 'module.exports = "portable";\n';
  write(sourceDir, file, contents);
  const { archives } = buildRelease({ sourceDir, outDir: path.join(root, 'archives'), name: 'pax-long', format: 'tar.gz' });
  const entry = tarEntries(archives[0]).get('pax-long/' + file);
  assert.equal(entry.pax, true);
  assert.equal(entry.contents.toString('utf8'), contents);
});

test('锁文件排除开发依赖和额外安装的包，嵌套生产包与归属声明可进入发行包', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  const prod = 'node_modules/@org/pkg';
  const nested = prod + '/node_modules/nested';
  const dev = prod + '/node_modules/dev-only';
  write(sourceDir, 'package-lock.json', JSON.stringify({ packages: {
    '': {}, [prod]: {}, [nested]: {}, [dev]: { dev: true }, 'node_modules/build-tool': { dev: true },
  } }));
  for (const pkg of [prod, nested, dev, 'node_modules/build-tool', 'node_modules/extraneous']) {
    write(sourceDir, pkg + '/index.js', 'module.exports = 1;');
  }
  const omit = ['TeSt/index.js', '__mocks__/mock.js', '.github/workflows/x.yml', 'index.js.map', 'index.d.mts',
    'GUIDE.markdown', 'migration.txt', 'tsconfig.build.json', 'webpack.config.js'];
  for (const file of [...omit, 'LICENSE.md', 'NOTICE.txt']) write(sourceDir, prod + '/' + file, 'fixture');
  const { stageDir, archives } = buildRelease({ sourceDir, outDir: path.join(root, 'out'), name: 'demo', withDeps: true });
  const names = zipEntries(archives[0]);
  for (const file of [prod + '/index.js', nested + '/index.js', prod + '/LICENSE.md', prod + '/NOTICE.txt']) {
    assert.ok(names.has('demo/' + file), file);
  }
  for (const file of [dev + '/index.js', 'node_modules/build-tool/index.js', 'node_modules/extraneous/index.js',
    ...omit.map(file => prod + '/' + file)]) assert.ok(!names.has('demo/' + file), file);
  write(stageDir, dev + '/index.js', 'fixture');
  for (const file of ['index.js.map', 'test/index.js']) write(stageDir, prod + '/' + file, 'fixture');
  assert.throws(() => runReleaseSecurityGate(stageDir), error =>
    error.issues.includes(dev + ' 不在生产依赖清单中') &&
    ['index.js.map', 'test'].every(file => error.issues.includes(prod + '/' + file + ' 属于禁运路径')));
});

test('归档条目与门禁清单不符时不发布 ZIP 和校验清单', t => {
  const root = scratch(t);
  const sourceDir = sourceFixture(root);
  const outDir = path.join(root, 'out');
  const writeSync = fs.writeSync;
  t.mock.method(fs, 'writeSync', (fd, bytes, ...args) => {
    // Simulate a ZIP writer emitting an incorrect central-directory filename.
    if (bytes.length >= 46 && bytes.readUInt32LE(0) === 0x02014b50 && bytes.toString('utf8', 46) === 'demo/server.js') {
      bytes = Buffer.from(bytes);
      bytes.write('demo/unused.js', 46);
    }
    return writeSync(fd, bytes, ...args);
  });
  assert.throws(() => buildRelease({ sourceDir, outDir, name: 'demo' }), /ZIP 本地文件名与目录不符/);
  assert.deepEqual(fs.readdirSync(outDir), []);
});
