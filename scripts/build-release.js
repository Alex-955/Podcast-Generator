'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { createHash } = require('node:crypto');
const { deflateRawSync, gzipSync, gunzipSync } = require('node:zlib');
const dotenv = require('dotenv');

const SOURCE_DIR = path.resolve(__dirname, '..');
const FORMATS = ['zip', 'tar.gz', 'both', 'dir'];
const ROOT_FILES = ['server.js', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', '.env.example'];
const PUBLIC_FILES = ['index.html', 'style.css', 'app.js', 'inputSource.js', 'audioEngine.js'].map(file => 'public/' + file);
const SCRIPTS = ['scripts/start-portable.js', 'scripts/build-mac-launcher.sh'];
const PLACEHOLDERS = ['public/podcasts/.gitkeep', 'data/.gitkeep'];
const LAUNCHERS = {
  'macos.command': 'AI 妙听.command',
  'windows.bat': 'AI 妙听.bat',
};
const LAUNCHER_FILES = Object.entries(LAUNCHERS).flatMap(([source, target]) => ['scripts/launchers/' + source, target]);
const REQUIRED_FILES = [...ROOT_FILES, ...PUBLIC_FILES, ...SCRIPTS, ...PLACEHOLDERS, ...LAUNCHER_FILES];
const DEPENDENCY_DOC = /^(?:readme|history|changelog|changes|security|contributing)(?:\.[a-z]+)?$/i;
const CREDENTIAL_FIELD = /(?:KEY|TOKEN|SECRET|PASSWORD|APP_ID)$/i;
const ZIP_UTF8 = 0x0800;
const ZIP_32_LIMIT = 0xffffffff;
const TAR_BLOCK_SIZE = 512;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

const CONTENT_RULES = [
  ['本机绝对路径', /(?:^|[\s"'\x60(=:])\/(?:Users|home)\/[^\s/\\"'\x60<>),;:]+(?:\/|$|[\s"'\x60<>),;:])/],
  ['本机绝对路径', /(?:^|[\s"'\x60(=:])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\s/\\"'\x60<>),;:]+(?:[\\/]|$|[\s"'\x60<>),;:])/i],
  ['私钥头', /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-{5}/i],
  ['疑似 API 密钥', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
];

function parseArgs(argv) {
  const options = { format: 'zip' };
  const values = new Map([
    ['--out-dir', 'outDir'], ['--name', 'name'], ['--format', 'format'], ['--source-dir', 'sourceDir'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--with-deps') {
      options.withDeps = true;
    } else if (values.has(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('缺少 ' + flag + ' 的值');
      options[values.get(flag)] = value;
    } else {
      throw new Error('无法识别发行包构建参数');
    }
  }
  validateFormat(options.format);
  return options;
}

function validateFormat(format) {
  if (!FORMATS.includes(format)) throw new Error('--format 必须为 zip、tar.gz、both 或 dir');
}

function validateName(name) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name) ||
      /[ .]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('发行包名称必须是可在 Windows 和 macOS 使用的单个目录名');
  }
}

function plainFile(sourceDir, relative) {
  const filename = path.join(sourceDir, relative);
  if (!fs.lstatSync(filename, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('缺少常规白名单文件：' + relative);
  }
  return filename;
}

function plainDirectory(sourceDir, relative) {
  const directory = path.join(sourceDir, relative);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('缺少常规目录：' + relative);
  }
  return directory;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function resolveOutputPath(outDir) {
  const components = [];
  let ancestor = outDir;
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
    components.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const existingAncestor = fs.realpathSync.native(ancestor);
  return { existingAncestor, realOutDir: path.join(existingAncestor, ...components), exists: components.length === 0 };
}

function validateOutputPath(outDir, sourceDir, withDeps) {
  const subtrees = ['src', 'public', 'scripts'];
  if (withDeps) subtrees.push('node_modules');
  const { existingAncestor, realOutDir, exists } = resolveOutputPath(outDir);
  const realSourceDir = fs.realpathSync.native(sourceDir);
  const invalidOutput = () => new Error('发行输出目录不能是源码根目录，也不能位于会被复制的源码或依赖目录内');
  for (const [source, target] of [[sourceDir, outDir], [realSourceDir, realOutDir]]) {
    if (!path.relative(source, target) || subtrees.some(dir => isWithin(path.join(source, dir), target))) {
      throw invalidOutput();
    }
  }
  const sameDirectory = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const copiedDirectories = subtrees.map(dir => fs.lstatSync(path.join(realSourceDir, dir), {
    bigint: true, throwIfNoEntry: false,
  })).filter(stat => stat?.isDirectory());
  const sourceIdentity = fs.lstatSync(realSourceDir, { bigint: true });
  let ancestor = existingAncestor;
  for (;;) {
    const identity = fs.lstatSync(ancestor, { bigint: true });
    if ((exists && ancestor === existingAncestor && sameDirectory(identity, sourceIdentity)) ||
        copiedDirectories.some(dir => sameDirectory(identity, dir))) throw invalidOutput();
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return realOutDir;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copySourceTree(from, to, relative = 'src') {
  const directory = plainDirectory(from, relative);
  fs.mkdirSync(path.join(to, relative), { recursive: true });
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = relative + '/' + entry.name;
    if (entry.isDirectory()) copySourceTree(from, to, child);
    else if (entry.name.endsWith('.js')) copyFile(plainFile(from, child), path.join(to, child));
  }
}

const DEPENDENCY_DIRS = new Set([
  '.bin', '.cache', '.github', '.vscode', '.nyc_output', 'test', 'tests', '__tests__', '__mocks__',
  'example', 'examples', 'doc', 'docs', 'benchmark', 'benchmarks', 'coverage',
]);

function excludedDependency(relative, directory) {
  const parts = relative.toLowerCase().split('/');
  const name = parts.pop();
  if (parts.some(part => DEPENDENCY_DIRS.has(part)) || name === '.ds_store') return true;
  if (directory) return DEPENDENCY_DIRS.has(name);
  if (/^(?:tests?\.js|yarn\.lock|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json)$/.test(name) ||
      /\.(?:test|spec)\.(?:js|cjs|mjs)$/.test(name) ||
      /^(?:(?:eslint|prettier|jest|vitest|rollup|babel)\.config\.|\.nycrc|\.mocharc)/.test(name)) return true;
  if (/^(?:licen[cs]e|notice)/.test(name)) return false;
  return DEPENDENCY_DOC.test(name) ||
    /\.(?:map|d\.(?:ts|mts|cts)|tsbuildinfo|md|markdown|txt)$/.test(name) ||
    /^(?:\.npmignore|\.gitignore|\.editorconfig|\.travis\.yml|makefile|tsconfig.*\.json)$/.test(name) ||
    /^(?:\.eslintrc|\.prettierrc|\.babelrc|gruntfile|gulpfile|karma\.conf|webpack\.config)/.test(name);
}

function productionPackages(root, required = true) {
  const contents = fs.readFileSync(plainFile(root, 'package-lock.json'), 'utf8');
  let packages;
  try {
    ({ packages } = JSON.parse(contents));
  } catch {
    throw new Error('package-lock.json 格式无效');
  }
  if (!required) return null;
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(packages)) throw new Error('package-lock.json 缺少有效的 packages 索引');
  const production = new Map();
  for (const [relative, pkg] of Object.entries(packages)) {
    if (!isRecord(pkg) || (pkg.dev !== undefined && typeof pkg.dev !== 'boolean')) {
      throw new Error('package-lock.json 的 packages 条目无效');
    }
    if (!relative.startsWith('node_modules/')) continue;
    if (!/^(?:node_modules\/(?:@[\w.-]+\/)?[\w-][\w.-]*)(?:\/node_modules\/(?:@[\w.-]+\/)?[\w-][\w.-]*)*$/.test(relative)) {
      throw new Error('锁文件包含无效依赖路径');
    }
    if (!pkg.dev) production.set(relative, pkg);
  }
  if (!production.size) throw new Error('package-lock.json 的 packages 索引缺少生产依赖');
  return production;
}

function packageOwner(relative) {
  if (!relative.startsWith('node_modules/')) return null;
  const boundary = relative.lastIndexOf('/node_modules/') + 1;
  const suffix = relative.slice(boundary + 'node_modules/'.length).split('/');
  const count = suffix[0].startsWith('@') ? 2 : 1;
  if (suffix.length < count) return null; // Scope container.
  return relative.slice(0, boundary) + 'node_modules/' + suffix.slice(0, count).join('/');
}

function copyDependencies(sourceDir, stageDir) {
  const source = fs.realpathSync(plainDirectory(sourceDir, 'node_modules'));
  const packages = productionPackages(sourceDir);
  function copyEntry(from, relative, ancestors) {
    const real = fs.realpathSync(from);
    if (!isWithin(source, real)) throw new Error('依赖符号链接指向 node_modules 之外：' + relative);
    const physical = path.relative(source, real).split(path.sep).join('/');
    const stat = fs.statSync(real);
    if (excludedDependency(relative, stat.isDirectory()) || excludedDependency(physical, stat.isDirectory())) return;
    if (physical) {
      const owner = packageOwner('node_modules/' + physical);
      if (!packages.has(owner)) throw new Error('依赖链接目标不在生产依赖清单中：' + relative);
    }
    const to = path.join(stageDir, relative);
    if (stat.isFile()) {
      copyFile(real, to);
    } else if (stat.isDirectory()) {
      if (ancestors.has(real)) throw new Error('依赖符号链接存在循环：' + relative);
      fs.mkdirSync(to, { recursive: true });
      const parents = new Set([...ancestors, real]);
      for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue; // Nested packages have their own lock entries.
        const child = relative + '/' + entry.name;
        if (!excludedDependency(child, entry.isDirectory())) copyEntry(path.join(real, entry.name), child, parents);
      }
    } else {
      throw new Error('依赖目录包含非常规文件：' + relative);
    }
  }
  for (const [relative, pkg] of packages) {
    const from = path.join(sourceDir, relative);
    if (pkg.optional && !fs.existsSync(from)) continue;
    if (!fs.statSync(from, { throwIfNoEntry: false })?.isDirectory()) throw new Error('缺少生产依赖：' + relative);
    copyEntry(from, relative, new Set());
  }
}

function writeLaunchers(sourceDir, stageDir) {
  fs.mkdirSync(path.join(stageDir, 'scripts/launchers'), { recursive: true });
  for (const [filename, rootName] of Object.entries(LAUNCHERS)) {
    const nested = 'scripts/launchers/' + filename;
    const lf = fs.readFileSync(plainFile(sourceDir, nested), 'utf8').replace(/\r\n?/g, '\n');
    const bat = filename.endsWith('.bat');
    for (const relative of [nested, rootName]) {
      const target = path.join(stageDir, relative);
      fs.writeFileSync(target, bat ? lf.replace(/\n/g, '\r\n') : lf);
      if (!bat) fs.chmodSync(target, 0o755);
    }
  }
}

function stageFiles(sourceDir, stageDir, withDeps) {
  for (const dir of ['public', 'scripts', 'scripts/launchers']) plainDirectory(sourceDir, dir);
  for (const relative of [...ROOT_FILES, ...PUBLIC_FILES, ...SCRIPTS]) {
    copyFile(plainFile(sourceDir, relative), path.join(stageDir, relative));
  }
  copySourceTree(sourceDir, stageDir);
  for (const relative of PLACEHOLDERS) {
    const file = path.join(stageDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  writeLaunchers(sourceDir, stageDir);
  if (withDeps) copyDependencies(sourceDir, stageDir);
}

function forbiddenPath(relative) {
  const lower = relative.toLowerCase();
  const name = path.posix.basename(lower);
  return (name.startsWith('.env') && relative !== '.env.example') ||
    ['.git', '.ds_store', '启动 ai 妙听.app', 'ai 妙听.app', 'roadmap.md', 'plan.md', 'agents.md'].includes(name) ||
    /\.(?:log|pid)$/.test(name) || lower === 'plan' || lower.startsWith('plan/') ||
    lower === 'website' || lower.startsWith('website/') ||
    lower === 'test' || (lower.startsWith('data/') && relative !== 'data/.gitkeep') ||
    (lower.startsWith('public/podcasts/') && relative !== 'public/podcasts/.gitkeep');
}

function fileText(contents) {
  if (contents[0] === 0xff && contents[1] === 0xfe) return contents.toString('utf16le', 2);
  if (contents[0] === 0xfe && contents[1] === 0xff) {
    return contents.subarray(2, contents.length & ~1).swap16().toString('utf16le');
  }
  if (isUtf8(contents)) return contents.toString('utf8');
  return null;
}

function scanContent(contents, relative, issues) {
  let source = fileText(contents);
  if (relative === '.env.example' && (source === null || !isUtf8(contents))) {
    issues.push('.env.example 必须是有效的 UTF-8 文本文件');
    return;
  }
  if (source === null) return;
  if (relative === 'public/index.html') {
    // This fixed example is already present in the shipped password input.
    source = source.replace(/(<input type="password" id="settingApiKey" class="field-input" placeholder=")sk-x{24}(")/g, '$1$2');
  }
  const lines = source.split(/\r?\n/);
  if (relative === '.env.example') {
    const reported = new Set();
    for (const [index, line] of lines.entries()) {
      const field = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*[:=](.*)$/);
      if (field && CREDENTIAL_FIELD.test(field[1]) && field[2].trim()) {
        issues.push(relative + ':' + (index + 1) + ' 凭据字段 ' + field[1] + ' 必须为空');
        reported.add(field[1]);
      }
    }
    for (const [key, value] of Object.entries(dotenv.parse(source))) {
      if (CREDENTIAL_FIELD.test(key) && value.trim() && !reported.has(key)) {
        issues.push(relative + ' 凭据字段 ' + key + ' 必须为空');
      }
    }
  }
  for (const [reason, pattern] of CONTENT_RULES) {
    const index = lines.findIndex(line => pattern.test(line));
    if (index !== -1) issues.push(relative + ':' + (index + 1) + ' 包含' + reason);
  }
}

function runReleaseSecurityGate(stageDir, manifest = new Set()) {
  const issues = [];
  const files = new Set();
  const hasDeps = fs.existsSync(path.join(stageDir, 'node_modules'));
  const lock = fs.lstatSync(path.join(stageDir, 'package-lock.json'), { throwIfNoEntry: false });
  const packages = hasDeps || lock?.isFile() ? productionPackages(stageDir, hasDeps) : null;
  let hasSource = false;
  function scan(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const file = path.join(dir, entry.name);
      if (packages && packageOwner(relative) === relative && !packages.has(relative)) {
        issues.push(relative + ' 不在生产依赖清单中');
      }
      manifest.add(relative + (entry.isDirectory() ? '/' : ''));
      if (forbiddenPath(relative) || (relative.startsWith('node_modules/') && excludedDependency(relative, entry.isDirectory()))) {
        issues.push(relative + ' 属于禁运路径');
      } else if (entry.isDirectory()) {
        scan(file, relative + '/');
      } else if (!entry.isFile()) {
        issues.push(relative + ' 不是常规文件或目录');
      } else {
        files.add(relative);
        if (relative.startsWith('src/') && relative.endsWith('.js')) hasSource = true;
        const contents = fs.readFileSync(file);
        if (PLACEHOLDERS.includes(relative) && contents.length) issues.push(relative + ' 必须为空');
        if (LAUNCHER_FILES.includes(relative)) {
          const launcher = contents.toString('utf8');
          if (relative.endsWith('.bat')) {
            if (!launcher.includes('\r\n') || /[\r\n]/.test(launcher.replace(/\r\n/g, ''))) {
              issues.push(relative + ' 必须使用 CRLF 换行');
            }
          } else if (!launcher.includes('\n') || launcher.includes('\r') ||
              (process.platform !== 'win32' && (fs.statSync(file).mode & 0o777) !== 0o755)) {
            issues.push(relative + ' 必须使用 LF 换行并具有执行权限');
          }
        }
        scanContent(contents, relative, issues);
      }
    }
  }
  scan(stageDir);
  for (const relative of REQUIRED_FILES) {
    if (!files.has(relative)) issues.push('缺少必需文件：' + relative);
  }
  if (!hasSource) issues.push('缺少 src/ 中的 JavaScript 源码');
  if (issues.length) {
    throw Object.assign(new Error('发行包安全门禁未通过：\n' + issues.join('\n')), { issues });
  }
  return true;
}

function isExecutable(relative, stat) {
  return relative.endsWith('.command') || relative.endsWith('/scripts/build-mac-launcher.sh') ||
    (process.platform !== 'win32' && !relative.endsWith('.bat') && (stat.mode & 0o111) !== 0);
}

function* bundleEntries(dir, relative) {
  const file = path.join(dir, relative);
  const stat = fs.lstatSync(file);
  yield { relative, file, stat };
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(file)) yield* bundleEntries(dir, relative + '/' + child);
  }
}

function crc32(contents) {
  let crc = 0xffffffff;
  for (const byte of contents) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(relative, file, stat, offset) {
  const directory = stat.isDirectory();
  const filename = Buffer.from(relative + (directory ? '/' : ''), 'utf8');
  if (filename.length > 0xffff || stat.size >= ZIP_32_LIMIT) {
    throw new Error('条目超出标准 ZIP 大小限制');
  }
  const contents = directory ? Buffer.alloc(0) : fs.readFileSync(file);
  const method = contents.length ? 8 : 0;
  const bytes = method === 8 ? deflateRawSync(contents) : contents;
  if (bytes.length >= ZIP_32_LIMIT) throw new Error('压缩条目超出标准 ZIP 大小限制');

  // The local and central headers share these fields, including UTF-8 bit 11.
  const date = new Date(Math.max(Date.UTC(1980, 0, 1), Math.min(stat.mtimeMs, Date.UTC(2107, 11, 31, 23, 59, 58))));
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const fields = Buffer.alloc(22);
  fields.writeUInt16LE(20, 0);
  fields.writeUInt16LE(ZIP_UTF8, 2);
  fields.writeUInt16LE(method, 4);
  fields.writeUInt16LE(dosTime, 6);
  fields.writeUInt16LE(dosDate, 8);
  fields.writeUInt32LE(crc32(contents), 10);
  fields.writeUInt32LE(bytes.length, 14);
  fields.writeUInt32LE(contents.length, 18);

  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0);
  fields.copy(local, 4);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);

  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  fields.copy(central, 6);
  central.writeUInt16LE(filename.length, 28);
  const mode = isExecutable(relative, stat) ? 0o755 : 0o644;
  central.writeUInt32LE(directory ? ((0o040755 << 16) | 0x10) >>> 0 : ((0o100000 | mode) << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  filename.copy(central, 46);
  return { local, bytes, central };
}

function zipBundle(dir, name, archive) {
  const fd = fs.openSync(archive, 'wx');
  const centralHeaders = [];
  let offset = 0;
  function write(bytes) {
    if (offset + bytes.length >= ZIP_32_LIMIT) throw new Error('发行包超出标准 ZIP 大小限制');
    for (let position = 0; position < bytes.length;) {
      position += fs.writeSync(fd, bytes, position, bytes.length - position);
    }
    offset += bytes.length;
  }

  try {
    for (const { relative, file, stat } of bundleEntries(dir, name)) {
      if (centralHeaders.length === 0xfffe) throw new Error('发行包条目超出标准 ZIP 数量限制');
      const entry = zipEntry(relative, file, stat, offset);
      write(entry.local);
      write(entry.bytes);
      centralHeaders.push(entry.central);
    }
    const centralOffset = offset;
    for (const header of centralHeaders) write(header);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(centralHeaders.length, 8);
    end.writeUInt16LE(centralHeaders.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
}

function tarHeader(name, type, mode, size, mtime) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  function writeOctal(value, offset, width) {
    const octal = value.toString(8);
    if (octal.length >= width) throw new Error('条目超出标准 USTAR 数值范围');
    header.write(octal.padStart(width - 1, '0'), offset, 'ascii');
  }

  header.write(name, 0, 'ascii');
  writeOctal(mode, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(size, 124, 12);
  writeOctal(mtime, 136, 12);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  writeOctal(0, 329, 8);
  writeOctal(0, 337, 8);
  writeOctal(header.reduce((sum, byte) => sum + byte, 0), 148, 7);
  header[154] = 0;
  return header;
}

function paxPath(relative) {
  const payload = Buffer.from(' path=' + relative + '\n', 'utf8');
  let length = payload.length + 1;
  while (length !== payload.length + String(length).length) {
    length = payload.length + String(length).length;
  }
  return Buffer.concat([Buffer.from(String(length), 'ascii'), payload], length);
}

function tarGzBundle(dir, name, archive) {
  const chunks = [];
  function append(headerName, type, contents, mode, mtime) {
    chunks.push(tarHeader(headerName, type, mode, contents.length, mtime), contents);
    const remainder = contents.length % TAR_BLOCK_SIZE;
    if (remainder) chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
  }

  let paxIndex = 0;
  for (const { relative, file, stat } of bundleEntries(dir, name)) {
    const directory = stat.isDirectory();
    const mtime = Math.max(0, Math.floor(stat.mtimeMs / 1000));
    let entryName = directory ? relative + '/' : relative;
    if (Buffer.byteLength(entryName) > 99 || /[^\x20-\x7e]/.test(entryName)) {
      const index = ++paxIndex;
      append('PaxHeaders/' + index, 'x', paxPath(entryName), 0o644, mtime);
      entryName = 'PaxEntries/' + index + (directory ? '/' : '');
    }
    append(entryName, directory ? '5' : '0', directory ? Buffer.alloc(0) : fs.readFileSync(file),
      directory || isExecutable(relative, stat) ? 0o755 : 0o644, mtime);
  }
  chunks.push(Buffer.alloc(2 * TAR_BLOCK_SIZE));
  fs.writeFileSync(archive, gzipSync(Buffer.concat(chunks)), { flag: 'wx' });
}

// Read the names serialized by our ZIP32 and PAX writers back before publication.
function verifyArchive(archive, format, name, manifest) {
  const expected = new Set([name + '/', ...Array.from(manifest, entry => name + '/' + entry)]);
  function check(entry) {
    if (!expected.delete(entry)) throw new Error('发行归档包含未通过门禁的条目');
  }
  const bytes = fs.readFileSync(archive);
  if (format === 'zip') {
    const end = bytes.length - 22;
    if (bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('无效的 ZIP 结束记录');
    let offset = bytes.readUInt32LE(end + 16);
    for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('无效的 ZIP 目录条目');
      const length = bytes.readUInt16LE(offset + 28);
      const entry = bytes.toString('utf8', offset + 46, offset + 46 + length);
      const local = bytes.readUInt32LE(offset + 42);
      if (bytes.readUInt16LE(local + 26) !== length || bytes.toString('utf8', local + 30, local + 30 + length) !== entry) {
        throw new Error('ZIP 本地文件名与目录不符');
      }
      check(entry);
      offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    }
  } else {
    const tar = gunzipSync(bytes);
    let paxName;
    for (let offset = 0; offset < tar.length && tar[offset];) {
      const size = parseInt(tar.toString('ascii', offset + 124, offset + 136), 8);
      const data = offset + TAR_BLOCK_SIZE;
      if (tar[offset + 156] === 120) { // PAX extended header, a single UTF-8 path record.
        paxName = tar.toString('utf8', data, data + size).match(/^\d+ path=([\s\S]+)\n$/)?.[1];
        if (!paxName) throw new Error('无效的 PAX 路径');
      } else {
        check(paxName ?? tar.toString('ascii', offset, offset + 100).split('\0', 1)[0]);
        paxName = undefined;
      }
      offset = data + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    }
  }
  if (expected.size) throw new Error('发行归档缺少已通过门禁的条目');
}

function sha256(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(65536);
  try {
    for (let size; (size = fs.readSync(fd, chunk)) > 0;) hash.update(chunk.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function writeChecksums(outDir, scratch, sumsName, archiveNames) {
  const filename = path.join(outDir, sumsName);
  const sums = new Map();
  const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isFile()) throw new Error('已有的 SHA256SUMS.txt 不是常规文件');
    for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([0-9a-f]{64})  ([^/\\:\r\n]+(?:\.zip|\.tar\.gz))$/i);
      if (!match) continue;
      const [, digest, archive] = match;
      if (fs.lstatSync(path.join(outDir, archive), { throwIfNoEntry: false })?.isFile()) {
        sums.set(archive, digest.toLowerCase());
      }
    }
  }
  for (const archive of archiveNames) sums.set(archive, sha256(path.join(scratch, archive)));
  const lines = [...sums.keys()].sort().map(archive => sums.get(archive) + '  ' + archive);
  fs.writeFileSync(path.join(scratch, sumsName), lines.join('\n') + '\n');
  return filename;
}

function cleanupScratch(scratch, { budgetMs = 3000, delayMs = 100 } = {}) {
  const deadline = performance.now() + budgetMs;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
      return;
    } catch (error) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || !['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE'].includes(error.code)) throw error;
      Atomics.wait(waitBuffer, 0, 0, Math.min(delayMs, remaining));
      if (performance.now() >= deadline) throw error;
    }
  }
}

function buildRelease({
  sourceDir = SOURCE_DIR, outDir = 'dist', name, format = 'zip', withDeps = false,
} = {}) {
  validateFormat(format);
  sourceDir = path.resolve(sourceDir);
  outDir = validateOutputPath(path.resolve(outDir), sourceDir, withDeps);
  const { version } = JSON.parse(fs.readFileSync(plainFile(sourceDir, 'package.json'), 'utf8'));
  name ??= 'ai-podcast-generator-v' + version + '-portable';
  validateName(name);
  const formats = format === 'dir' ? [] : format === 'both' ? ['zip', 'tar.gz'] : [format];
  const archiveNames = formats.map(ext => name + '.' + ext);
  const stageDir = path.join(outDir, name);
  const archives = archiveNames.map(filename => path.join(outDir, filename));
  for (const target of [stageDir, ...archives]) {
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      throw new Error('发行包输出已存在，请选择其他名称或输出目录：' + path.basename(target));
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(outDir, '.podcast-release-'));
  const stage = path.join(scratch, name);
  const sumsName = 'SHA256SUMS.txt';
  let checksumFile = null;
  let published = false;
  try {
    stageFiles(sourceDir, stage, withDeps);
    const manifest = new Set();
    runReleaseSecurityGate(stage, manifest);
    for (let i = 0; i < formats.length; i++) {
      const target = path.join(scratch, archiveNames[i]);
      if (formats[i] === 'zip') zipBundle(scratch, name, target);
      else tarGzBundle(scratch, name, target);
      verifyArchive(target, formats[i], name, manifest);
    }
    if (archiveNames.length) checksumFile = writeChecksums(outDir, scratch, sumsName, archiveNames);
    fs.renameSync(stage, stageDir);
    for (let i = 0; i < archives.length; i++) fs.renameSync(path.join(scratch, archiveNames[i]), archives[i]);
    if (checksumFile) fs.renameSync(path.join(scratch, sumsName), checksumFile);
    published = true;
    return { stageDir, archives, checksumFile };
  } finally {
    try {
      cleanupScratch(scratch);
    } catch (error) {
      // Preserve the original build or security gate error if publishing failed.
      if (published) throw error;
    }
  }
}

if (require.main === module) {
  try {
    const result = buildRelease(parseArgs(process.argv.slice(2)));
    console.log('已构建便携目录：' + path.basename(result.stageDir));
    for (const file of result.archives) console.log('已生成压缩包：' + path.basename(file));
    if (result.checksumFile) console.log('已写入校验文件：SHA256SUMS.txt');
  } catch (error) {
    console.error('错误：' + (error.code ? '发行包构建失败（' + error.code + '）' : error.message));
    process.exitCode = 1;
  }
}

module.exports = { buildRelease, runReleaseSecurityGate, parseArgs };
