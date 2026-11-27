'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { scanContent, productionPackages, packageOwner, excludedDependency, forbiddenPath } = require('./build-release');

const applicationFiles = new Set([
  'package.json', 'server.js', 'LICENSE', 'TRADEMARK.md',
  'electron/main.js', 'electron/preload.js', 'electron/windowState.js', 'electron/navigationGuard.js', 'electron/migration.js',
  'public/index.html', 'public/style.css', 'public/app.js', 'public/inputSource.js', 'public/audioEngine.js',
  'src/services/atomicWrite.js', 'src/services/audioMerger.js', 'src/services/connectionTests.js',
  'src/services/edgeTtsAdapter.js', 'src/services/extractor.js', 'src/services/httpTts.js',
  'src/services/imageExtractor.js', 'src/services/instanceLock.js', 'src/services/llmCredentials.js',
  'src/services/llmModels.js', 'src/services/minimaxTtsProvider.js', 'src/services/mp3Utils.js',
  'src/services/podcastPublication.js', 'src/services/providerHttp.js', 'src/services/scriptEngine.js',
  'src/services/speechNormalize.js', 'src/services/styleRecommender.js', 'src/services/taskManager.js',
  'src/services/textPolisher.js', 'src/services/ttsCache.js', 'src/services/ttsCredentials.js',
  'src/services/ttsProvider.js', 'src/services/ttsService.js', 'src/services/validation.js',
  'src/services/volcengineTtsProvider.js',
]);
const applicationDirs = new Set(['electron', 'public', 'src', 'src/services']);
const { isUtf8 } = require('node:buffer');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stat = file => fs.lstatSync(file, { throwIfNoEntry: false });

function safeSegment(name) {
  if (!name || name === '.' || name === '..' || /[\\/:\x00-\x1f]/.test(name)) throw new Error('无效归档路径');
}

function walkDirectory(dir, visit, prefix = '') {
  if (!stat(dir)?.isDirectory()) throw new Error('需要普通文件夹');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    safeSegment(entry.name);
    const name = prefix + entry.name, file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      visit(name, null);
      walkDirectory(file, visit, name + '/');
    } else if (entry.isFile()) visit(name, fs.readFileSync(file));
    else throw new Error('禁止链接或特殊文件');
  }
}

function readArchive(file, visit) {
  if (!stat(file)?.isFile()) throw new Error('缺少 ASAR 文件');
  const bytes = fs.readFileSync(file);
  const start = 8 + bytes.readUInt32LE(4);
  const length = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(0) !== 4 || start > bytes.length || start !== 16 + Math.ceil(length / 4) * 4 ||
      bytes.readUInt32LE(8) !== start - 12) throw new Error('ASAR 头长度无效');
  const header = JSON.parse(bytes.toString('utf8', 16, 16 + length));
  const sidecar = file + '.unpacked';
  const physical = new Map();
  if (stat(sidecar)) walkDirectory(sidecar, (name, content) => {
    if (content !== null) physical.set(name, content);
    else visit(name, null);
  });
  const spans = [];
  function walk(files, prefix) {
    if (!record(files)) throw new Error('ASAR 文件清单无效');
    for (const [key, node] of Object.entries(files)) {
      safeSegment(key);
      const name = prefix + key;
      if (!record(node) || 'link' in node) throw new Error('ASAR 含链接或无效节点');
      if ('files' in node) {
        visit(name, null);
        walk(node.files, name + '/');
      } else {
        if (!Number.isSafeInteger(node.size) || node.size < 0) throw new Error('ASAR 文件长度无效');
        if (node.unpacked) {
          const content = physical.get(name);
          if (content?.length !== node.size) throw new Error('ASAR 外置文件不匹配');
          physical.delete(name);
          visit(name, content);
        } else {
          const position = Number(node.offset);
          if (typeof node.offset !== 'string' || !/^\d+$/.test(node.offset) ||
              !Number.isSafeInteger(position) || position + node.size > bytes.length - start) throw new Error('ASAR 文件越界');
          if (node.size) spans.push([position, position + node.size]);
          visit(name, bytes.subarray(start + position, start + position + node.size));
        }
      }
    }
  }
  walk(header.files, '');
  let end = 0;
  for (const [left, right] of spans.sort((a, b) => a[0] - b[0])) {
    if (left !== end) throw new Error('ASAR 文件范围不连续');
    end = right;
  }
  if (end !== bytes.length - start || physical.size) throw new Error('ASAR 含未登记内容');
}

function checkContent(name, bytes) {
  // Also scan byte strings in mixed/binary files. scanContent handles UTF-16
  // text and the known password-placeholder example in the shipped HTML.
  const issues = [];
  scanContent(bytes, name, issues);
  if (!isUtf8(bytes)) scanContent(Buffer.from(bytes.toString('latin1')), name, issues);
  let text = bytes.toString('utf8');
  if (name === 'public/app.js') text = text.replace("apiKey: 'ai_podcast_apikey'", '');
  const literalKey = /(?:^|[\s{,'"])(?:api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][a-z0-9_+./=-]{8,}["']/i;
  if (issues.length || literalKey.test(text) || /\/(?:private\/)?var\/folders\/[a-z0-9]{2}\/[\w-]{12,}\//i.test(text))
    throw new Error('安全扫描发现本机路径或疑似凭据');
}

function verifyBundle(file) {
  const packages = productionPackages(path.resolve(__dirname, '..'));
  // electron-builder hoists nested packages, so match their locked names and versions.
  const productionNames = new Set(), versions = new Set();
  for (const [location, pkg] of packages) {
    const name = location.split('node_modules/').at(-1);
    productionNames.add(name);
    versions.add(name + '@' + pkg.version);
  }
  const owners = new Set(), manifests = new Set(), found = new Set();
  function visit(name, bytes) {
    const directory = bytes === null;
    if (name === 'node_modules' && directory) return;
    if (name.startsWith('node_modules/')) {
      if (forbiddenPath(name) || excludedDependency(name, directory)) throw new Error('生产依赖含禁运文件');
      const owner = packageOwner(name);
      if (directory) {
        if (owner === name && !productionNames.has(owner.split('node_modules/').at(-1))) throw new Error('含非生产依赖');
        return;
      }
      if (!owner || owner === name) throw new Error('依赖路径无效');
      owners.add(owner);
      if (name === owner + '/package.json') {
        const pkg = JSON.parse(bytes);
        if (pkg.name !== owner.split('node_modules/').at(-1) || !versions.has(pkg.name + '@' + pkg.version))
          throw new Error('含非生产依赖');
        manifests.add(owner);
      }
    } else if (!(directory ? applicationDirs : applicationFiles).has(name)) {
      throw new Error('包含白名单以外的路径');
    }
    if (directory) return;
    found.add(name);
    checkContent(name, bytes);
  }
  if (path.basename(file) === 'app.asar') readArchive(file, visit);
  else walkDirectory(file, visit);
  for (const name of applicationFiles) if (!found.has(name)) throw new Error('缺少 ' + name);
  for (const owner of owners) if (!manifests.has(owner)) throw new Error('依赖缺少清单');
  return found.size;
}

function resourcesAt(dir) {
  const runtimeFiles = new Set(['icon.icns', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'app-update.yml', 'elevate.exe']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isDirectory() && /^[a-z]{2,3}(?:_[A-Za-z0-9]+)*\.lproj$/.test(name)) {
      if (fs.readdirSync(path.join(dir, name)).length) throw new Error('本地化资源含额外文件');
    } else if (entry.isFile() && runtimeFiles.has(name)) {
      checkContent(name, fs.readFileSync(path.join(dir, name)));
    } else if (!(entry.isDirectory() && ['app', 'app.asar.unpacked', 'public'].includes(name)) &&
               !(entry.isFile() && name === 'app.asar')) throw new Error('外置资源不在白名单内');
  }
  const publicDir = path.join(dir, 'public');
  const marker = stat(path.join(publicDir, 'podcasts', '.gitkeep'));
  if (!marker?.isFile() || marker.size !== 0) throw new Error('缺少空的播客占位文件');
  walkDirectory(publicDir, (name, bytes) => {
    if (!(name === 'podcasts' && bytes === null) && !(name === 'podcasts/.gitkeep' && bytes?.length === 0))
      throw new Error('外置资源不在白名单内');
  });
  const archive = path.join(dir, 'app.asar'), app = path.join(dir, 'app');
  if (stat(archive) && stat(app)) throw new Error('存在重复的应用目录');
  if (stat(archive)) return archive;
  if (stat(app)?.isDirectory()) return app;
  throw new Error('缺少桌面应用资源');
}

function locate(target) {
  const base = path.basename(target);
  if (base === 'app.asar' || base === 'app') return [target];
  if (base.endsWith('.app')) return [resourcesAt(path.join(target, 'Contents', 'Resources'))];
  if (base.toLowerCase() === 'resources') return [resourcesAt(target)];
  if (stat(path.join(target, 'resources'))) return [resourcesAt(path.join(target, 'resources'))];
  const bundles = [];
  for (const dir of fs.readdirSync(target, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sub = path.join(target, dir.name);
    if (/^win(?:-[\w]+)*-unpacked$/.test(dir.name) || dir.name.endsWith('.app')) bundles.push(...locate(sub));
    else if (/^mac(?:-[\w]+)?$/.test(dir.name)) bundles.push(...locate(sub));
  }
  if (!bundles.length) throw new Error('没有找到待检查的桌面应用');
  return bundles;
}

function verifyTarget(target) {
  if (target.toLowerCase().endsWith('.dmg')) return verifyDmg(target);
  if (target.toLowerCase().endsWith('.exe')) return verifyNsis(target);
  return locate(target).map(verifyBundle);
}

function verifyInstalledResources(resources) {
  if (!stat(resources)?.isDirectory()) throw new Error('缺少普通资源目录');
  const archive = resourcesAt(resources);
  if (path.basename(archive) !== 'app.asar') throw new Error('安装包缺少 ASAR');
  return verifyBundle(archive);
}

function verifyDmg(target) {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoting-dmg-'));
  let attached = false;
  try {
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-plist', '-mountpoint', mount, target]);
    attached = true;
    const app = 'AI 妙听.app';
    if (!stat(path.join(mount, app))?.isDirectory() ||
        fs.readlinkSync(path.join(mount, 'Applications')) !== '/Applications') throw new Error('安装盘布局无效');
    for (const entry of fs.readdirSync(mount, { withFileTypes: true })) {
      if ([app, 'Applications'].includes(entry.name)) continue;
      if (entry.isFile() && ['.DS_Store', '.VolumeIcon.icns', '.background.tiff'].includes(entry.name)) continue;
      if (entry.isDirectory() && ['.background', '.fseventsd'].includes(entry.name)) {
        const allowed = entry.name === '.background' ? /^background\.(?:tiff?|png)$/i : /^(?:[a-f0-9]+|fseventsd-uuid|no_log)$/;
        walkDirectory(path.join(mount, entry.name), (name, bytes) => {
          if (!bytes || !allowed.test(name)) throw new Error('安装盘元数据含额外文件');
        });
        continue;
      }
      throw new Error('安装盘根目录含额外文件');
    }
    return [verifyInstalledResources(path.join(mount, app, 'Contents', 'Resources'))];
  } finally {
    if (attached) {
      try { execFileSync('hdiutil', ['detach', mount]); }
      catch { execFileSync('hdiutil', ['detach', '-force', mount]); }
    }
    fs.rmdirSync(mount);
  }
}

function verifyNsis(target) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoting-nsis-'));
  const extract = (file, dir, type) => execFileSync('7z',
    ['x', '-t' + type, '-y', '-bd', '-o' + dir, '--', file], { stdio: 'ignore' });
  try {
    const outer = path.join(temp, 'outer');
    extract(target, outer, 'Nsis');
    const plugins = path.join(outer, '$PLUGINSDIR');
    const payloads = stat(plugins)?.isDirectory() ? fs.readdirSync(plugins).filter(name => /^app-.*\.7z$/i.test(name)) : [];
    if (payloads.length === 0) return [verifyInstalledResources(path.join(outer, 'resources'))];
    if (payloads.length !== 1 || payloads[0] !== 'app-64.7z' || stat(path.join(outer, 'resources'))) {
      throw new Error('NSIS 安装负载不匹配');
    }
    const payload = path.join(plugins, payloads[0]);
    if (!stat(payload)?.isFile()) throw new Error('NSIS 安装负载无效');
    const inner = path.join(temp, 'payload');
    extract(payload, inner, '7z');
    return [verifyInstalledResources(path.join(inner, 'resources'))];
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { verifyBundle, verifyTarget, locate, applicationFiles };
if (require.main === module) {
  try {
    for (const count of verifyTarget(path.resolve(process.argv[2] || 'dist'))) {
      console.log('桌面包通过安全门禁，已检查 %d 个应用文件', count);
    }
  } catch (error) {
    console.error(error.code || (error instanceof SyntaxError ? 'ASAR 清单无效' : error.message));
    process.exitCode = 1;
  }
}
