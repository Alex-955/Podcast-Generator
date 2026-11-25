'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const SOURCE_DIR = path.resolve(__dirname, '..');
const FORMATS = ['zip', 'tar.gz', 'both', 'dir'];
const ROOT_FILES = ['server.js', 'package.json', 'package-lock.json', 'README.md', 'ROADMAP.md', 'LICENSE', '.env.example'];
const PUBLIC_FILES = ['index.html', 'style.css', 'app.js', 'inputSource.js', 'audioEngine.js'].map(file => 'public/' + file);
const SCRIPTS = ['scripts/start-portable.js', 'scripts/build-mac-launcher.sh'];
const PLACEHOLDERS = ['public/podcasts/.gitkeep', 'data/.gitkeep'];
const LAUNCHERS = {
  'start-windows.bat': '启动 AI 妙听.bat',
  'stop-windows.bat': '停止 AI 妙听.bat',
  'start-macos.command': '启动 AI 妙听.command',
  'stop-macos.command': '停止 AI 妙听.command',
};
const LAUNCHER_FILES = Object.entries(LAUNCHERS).flatMap(([source, target]) => ['scripts/launchers/' + source, target]);
const REQUIRED_FILES = [...ROOT_FILES, ...PUBLIC_FILES, ...SCRIPTS, ...PLACEHOLDERS, ...LAUNCHER_FILES];

const CONTENT_RULES = [
  ['本机绝对路径', /\/(?:Users|home)\/[^/\r\n"'<>]+\/|\b[A-Z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\r\n"'<>]+[\\/]{1,2}/i],
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

function copyDependencies(sourceDir, stageDir) {
  const source = fs.realpathSync(plainDirectory(sourceDir, 'node_modules'));
  function copyEntry(from, to, relative, ancestors) {
    const real = fs.realpathSync(from);
    const within = path.relative(source, real);
    if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) {
      throw new Error('依赖符号链接指向 node_modules 之外：' + relative);
    }
    if (within.split(path.sep).includes('.cache')) return;
    const stat = fs.statSync(real);
    if (stat.isFile()) {
      copyFile(real, to);
    } else if (stat.isDirectory()) {
      if (ancestors.has(real)) throw new Error('依赖符号链接存在循环：' + relative);
      fs.mkdirSync(to, { recursive: true });
      const parents = new Set([...ancestors, real]);
      for (const entry of fs.readdirSync(real)) {
        if (entry.toLowerCase() === '.cache') continue;
        copyEntry(path.join(real, entry), path.join(to, entry), relative + '/' + entry, parents);
      }
    } else {
      throw new Error('依赖目录包含非常规文件：' + relative);
    }
  }
  copyEntry(source, path.join(stageDir, 'node_modules'), 'node_modules', new Set());
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
    ['.git', '.ds_store', '启动 ai 妙听.app'].includes(name) || /\.(?:log|pid)$/.test(name) ||
    lower === 'test' || lower === 'data/tts-cache' || /^data\/tasks\/.*\.json$/.test(lower) ||
    (lower.startsWith('public/podcasts/') && relative !== 'public/podcasts/.gitkeep');
}

function fileText(contents) {
  if (contents[0] === 0xff && contents[1] === 0xfe) return contents.toString('utf16le', 2);
  if (contents[0] === 0xfe && contents[1] === 0xff) {
    return contents.subarray(2, contents.length & ~1).swap16().toString('utf16le');
  }
  if (isUtf8(contents) && !contents.includes(0)) return contents.toString('utf8');
  return null;
}

function scanContent(contents, relative, issues) {
  let source = fileText(contents);
  if (source === null) return;
  if (relative === 'public/index.html') {
    // This fixed example is already present in the shipped password input.
    source = source.replace(/(<input type="password" id="settingApiKey" class="field-input" placeholder=")sk-x{24}(")/g, '$1$2');
  }
  const lines = source.split(/\r?\n/);
  for (const [reason, pattern] of CONTENT_RULES) {
    const index = lines.findIndex(line => pattern.test(line));
    if (index !== -1) issues.push(relative + ':' + (index + 1) + ' 包含' + reason);
  }
}

function runReleaseSecurityGate(stageDir) {
  const issues = [];
  const files = new Set();
  let hasSource = false;
  function scan(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const file = path.join(dir, entry.name);
      if (forbiddenPath(relative)) {
        issues.push(relative + ' 属于禁运路径');
      } else if (entry.isDirectory()) {
        scan(file, relative + '/');
      } else if (!entry.isFile()) {
        issues.push(relative + ' 不是常规文件或目录');
      } else {
        files.add(relative);
        if (relative.startsWith('node_modules/')) continue;
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
              (process.platform !== 'win32' && !(fs.statSync(file).mode & 0o111))) {
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

function runArchiveTool(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd, shell: false, stdio: 'ignore', windowsHide: true, env: { ...process.env, COPYFILE_DISABLE: '1', ...env },
  });
  if (result.error?.code === 'ENOENT') return false;
  if (result.error || result.status !== 0) throw new Error('压缩工具 ' + command + ' 执行失败');
  return true;
}

function zipBundle(dir, name, archive) {
  if (process.platform === 'win32') {
    const script = 'Compress-Archive -LiteralPath $env:PODCAST_RELEASE_STAGE -DestinationPath $env:PODCAST_RELEASE_TARGET -ErrorAction Stop';
    if (runArchiveTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], dir, {
      PODCAST_RELEASE_STAGE: path.join(dir, name), PODCAST_RELEASE_TARGET: archive,
    })) return;
  } else {
    if (runArchiveTool('zip', ['-q', '-r', archive, name], dir)) return;
    if (process.platform === 'darwin' &&
        runArchiveTool('ditto', ['-c', '-k', '--keepParent', name, archive], dir)) return;
    if (process.platform === 'linux' &&
        runArchiveTool('python3', ['-m', 'zipfile', '-c', archive, name], dir)) return;
  }
  throw new Error('当前系统没有可用的 ZIP 压缩工具');
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

function buildRelease({
  sourceDir = SOURCE_DIR, outDir = 'dist', name, format = 'zip', withDeps = false,
} = {}) {
  validateFormat(format);
  sourceDir = path.resolve(sourceDir);
  outDir = path.resolve(outDir);
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
  try {
    stageFiles(sourceDir, stage, withDeps);
    runReleaseSecurityGate(stage);
    for (let i = 0; i < formats.length; i++) {
      const target = path.join(scratch, archiveNames[i]);
      if (formats[i] === 'zip') zipBundle(scratch, name, target);
      else if (!runArchiveTool('tar', ['-czf', target, name], scratch)) throw new Error('找不到 tar 压缩工具');
    }
    if (archiveNames.length) {
      const sums = archiveNames.map(filename => sha256(path.join(scratch, filename)) + '  ' + filename);
      fs.writeFileSync(path.join(scratch, sumsName), sums.join('\n') + '\n');
      checksumFile = path.join(outDir, sumsName);
    }
    fs.renameSync(stage, stageDir);
    for (let i = 0; i < archives.length; i++) fs.renameSync(path.join(scratch, archiveNames[i]), archives[i]);
    if (checksumFile) fs.renameSync(path.join(scratch, sumsName), checksumFile);
    return { stageDir, archives, checksumFile };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
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
