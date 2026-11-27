'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanContent, productionPackages, packageOwner } = require('./build-release');

const required = ['electron/main.js', 'electron/preload.js', 'server.js', 'package.json', 'public/index.html',
  'LICENSE', 'TRADEMARK.md'];
const filesAtRoot = new Set(['package.json', 'server.js', 'LICENSE', 'TRADEMARK.md']);
const directories = new Set(['electron', 'src', 'public', 'node_modules']);
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
  const versions = new Set([...packages].map(([location, pkg]) =>
    location.split('node_modules/').at(-1) + '@' + pkg.version));
  const owners = new Set(), manifests = new Set(), found = new Set();
  function visit(name, bytes) {
    const parts = name.split('/');
    if ((!directories.has(parts[0]) && !(bytes && filesAtRoot.has(name))) ||
        parts.some(part => /^(?:\.env.*|\.git|\.ds_store|tests?|__tests__|plan\.md|agents\.md|roadmap\.md)$/i.test(part)) ||
        /\.map$/i.test(name) || (name.startsWith('public/podcasts/') && name !== 'public/podcasts/.gitkeep'))
      throw new Error('包含白名单以外的路径');
    if (bytes === null) return;
    if (parts[0] === 'node_modules') {
      const owner = packageOwner(name);
      owners.add(owner);
      if (name === owner + '/package.json') {
        const pkg = JSON.parse(bytes);
        if (pkg.name !== owner.split('node_modules/').at(-1) || !versions.has(pkg.name + '@' + pkg.version))
          throw new Error('含非生产依赖');
        manifests.add(owner);
      }
    }
    if (name === 'public/podcasts/.gitkeep' && bytes.length) throw new Error('播客占位文件必须为空');
    found.add(name);
    checkContent(name, bytes);
  }
  if (path.basename(file) === 'app.asar') readArchive(file, visit);
  else walkDirectory(file, visit);
  for (const name of required) if (!found.has(name)) throw new Error('缺少 ' + name);
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
  if (stat(publicDir)) walkDirectory(publicDir, (name, bytes) => {
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

module.exports = { verifyBundle, locate };
if (require.main === module) {
  try {
    for (const bundle of locate(path.resolve(process.argv[2] || 'dist'))) {
      console.log('桌面包通过安全门禁，已检查 %d 个文件', verifyBundle(bundle));
    }
  } catch (error) {
    console.error(error.code || (error instanceof SyntaxError ? 'ASAR 清单无效' : error.message));
    process.exitCode = 1;
  }
}
