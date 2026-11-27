'use strict';

const { lstatSync, readFileSync, readlinkSync, unlinkSync } = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { parseEnv } = require('node:util');

const { processExists } = require('../src/services/instanceLock');

const APP_NAME = 'ai-podcast-generator';
const DEFAULT_PORT = 3456;
const DEFAULT_PORT_FALLBACK_MAX = 3475;
const DEFAULT_PROJECT_DIR = path.resolve(__dirname, '..');
const PID_FILE = 'server.pid';
const START_TIMEOUT_MS = 8000;

function supportsBundledCa(flags = process.allowedNodeEnvironmentFlags) {
  return flags?.has('--use-bundled-ca') === true;
}

function parseArgs(argv) {
  const options = { action: 'start' };
  const values = new Map([
    ['--host', 'host'], ['--port', 'port'], ['--project-dir', 'projectDir'],
    ['--data-dir', 'dataDir'], ['--podcasts-dir', 'podcastsDir'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (values.has(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`缺少 ${flag} 的值`);
      options[values.get(flag)] = flag === '--port' ? parsePort(value) : value;
    } else if (flag === '--stop' || flag === '--status') {
      const action = flag.slice(2);
      if (options.action !== 'start' && options.action !== action) {
        throw new Error('--stop 和 --status 不能同时使用');
      }
      options.action = action;
    } else if (flag === '--open' || flag === '--no-open') {
      options.open = flag === '--open';
    } else if (flag === '--lan' || flag === '--foreground') {
      options[flag.slice(2)] = true;
    } else {
      throw new Error('无法识别启动参数');
    }
  }
  return options;
}

function parsePort(value) {
  const text = String(value).trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65535) throw new Error('端口必须是 0 至 65535 的整数');
  return port;
}

function validHost(host) {
  return typeof host === 'string' && (host === 'localhost' || net.isIP(host) !== 0);
}

function settings(options) {
  const env = options.env ?? process.env;
  const projectDir = path.resolve(options.projectDir ?? DEFAULT_PROJECT_DIR);
  let fileEnv;
  try {
    fileEnv = parseEnv(readFileSync(path.join(projectDir, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const setting = key => env[key] ?? fileEnv?.[key];
  const dataDir = path.resolve(projectDir, options.dataDir ?? (setting('DATA_DIR') || 'data'));
  const podcastsDir = path.resolve(projectDir, options.podcastsDir ?? (setting('PODCASTS_DIR') || 'public/podcasts'));
  const host = options.lan ? '0.0.0.0' : (options.host ?? (setting('HOST') || '127.0.0.1'));
  if (!validHost(host)) throw new Error('HOST 必须是 localhost 或有效的 IP 地址');
  const explicitPort = options.port !== undefined || Boolean(setting('PORT')?.trim());
  const port = explicitPort ? parsePort(options.port ?? setting('PORT')) : DEFAULT_PORT;
  return { env, projectDir, dataDir, podcastsDir, host, port, explicitPort, pidFile: path.join(dataDir, PID_FILE) };
}

function connectHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

function localUrl(host, port) {
  host = connectHost(host);
  return `http://${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
}

function probeHealth(host = '127.0.0.1', port = DEFAULT_PORT, timeout = 400) {
  if (!validHost(host) || !port) return Promise.resolve(null);
  return new Promise(resolve => {
    const req = http.get({
      hostname: connectHost(host), port, path: '/api/health', agent: false, signal: AbortSignal.timeout(timeout),
    }, res => {
      res.on('error', () => resolve(null));
      if (res.statusCode !== 200) {
        res.destroy();
        resolve(null);
        return;
      }
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 8192) {
          res.destroy();
          resolve(null);
        }
      });
      res.on('end', () => {
        try {
          const health = JSON.parse(body);
          resolve(health?.app === APP_NAME && health.status === 'ok' ? health : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
  });
}

function tryPort(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(new Error(`无法监听端口 ${port}（${error.code ?? '未知错误'}）`));
    });
    server.listen({ host, port, exclusive: true }, () => {
      const available = server.address().port;
      server.close(() => resolve(available));
    });
  });
}

async function findAvailablePort(host = '127.0.0.1', port = DEFAULT_PORT, explicit = false) {
  if (explicit) {
    const available = await tryPort(host, port);
    if (available === null) throw new Error(`指定端口 ${port} 已被其他服务占用，请选择其他端口`);
    return available;
  }
  for (let candidate = port; candidate <= DEFAULT_PORT_FALLBACK_MAX; candidate++) {
    const available = await tryPort(host, candidate);
    if (available !== null) return available;
  }
  return tryPort(host, 0);
}

function getLanAddresses(interfaces = os.networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter(info =>
    !info.internal && net.isIPv4(info.address),
  ).map(info => info.address))];
}

function isPrivateAddress(host) {
  if (net.isIPv6(host)) return host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host);
  if (!net.isIPv4(host)) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 10 || (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254);
}

function resolveBrowserCommand(url, platform = process.platform, lanAddresses = getLanAddresses()) {
  const authority = typeof url === 'string' && url.match(/^https?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.]+)(?::\d+)?(?:[/?#]|$)/i);
  if (!authority || /[^a-z0-9._~:/?#\[\]=+-]/i.test(url)) throw new Error('浏览器地址无效');
  const parsed = new URL(url);
  const host = authority[1].toLowerCase().replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && host !== '127.0.0.1' && !isPrivateAddress(host) && !lanAddresses.includes(host)) {
    throw new Error('浏览器只能打开本机或局域网地址');
  }
  // Use the validated, unmodified URL when composing the Windows start command.
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error('浏览器地址无效');
  switch (platform) {
    case 'darwin': return { command: 'open', args: [url] };
    case 'win32': return { command: 'cmd.exe', args: ['/c', 'start', '', url] };
    case 'linux': return { command: 'xdg-open', args: [url] };
    default: throw new Error('当前系统不支持自动打开浏览器');
  }
}

function openBrowser(url, options, config) {
  if (!options.open || config.env.CI?.toLowerCase() === 'true') return;
  const warn = options.warn ?? console.warn;
  try {
    const { command, args } = resolveBrowserCommand(url);
    const browser = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true });
    browser.once('error', () => warn('未能自动打开浏览器，请手动访问上方地址'));
    browser.once('exit', code => {
      if (code !== 0) warn('未能自动打开浏览器，请手动访问上方地址');
    });
  } catch {
    warn('未能自动打开浏览器，请手动访问上方地址');
  }
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff;
}

async function readPidRecord(file) {
  let contents;
  try {
    contents = (await fs.readFile(file, 'utf8')).trim();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (/^\d+$/.test(contents)) {
    const pid = Number(contents);
    return validPid(pid) ? { pid, script: 'server.js' } : null;
  }
  try {
    const record = JSON.parse(contents);
    if (!validPid(record?.pid) || record.script !== 'server.js' ||
        !Number.isInteger(record.port) || record.port < (record.instance ? 0 : 1) || record.port > 65535 ||
        !validHost(record.host) ||
        (record.instance !== undefined && !/^[0-9a-f-]{36}$/.test(record.instance))) return null;
    return record;
  } catch {
    return null;
  }
}

function queryProcess(pid, platform) {
  if (!processExists(pid)) return null;
  const options = { encoding: 'utf8', shell: false, windowsHide: true, timeout: platform === 'win32' ? 10000 : 2500 };
  if (platform === 'win32') {
    const script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop).CommandLine`;
    const powershell = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
    const commandLine = powershell.status === 0 && powershell.stdout.trim();
    if (commandLine) return commandLine;
    const wmic = spawnSync('wmic.exe', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'],
      { ...options, encoding: 'buffer' });
    if (wmic.status === 0) {
      const encoding = wmic.stdout.includes(0) ? 'utf16le' : 'utf8';
      const fallback = wmic.stdout.toString(encoding).replace(/^\uFEFF/, '').match(/^CommandLine=(.*)$/m)?.[1].trim();
      if (fallback) return fallback;
    }
    if (!processExists(pid)) return null;
  } else {
    const ps = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], options);
    if (ps.status === 1 && !ps.stderr.trim()) return null;
    if (ps.status === 0) return ps.stdout.trim();
  }
  throw new Error('无法查询 PID 对应的进程，请重试');
}

function processCwd(pid, platform) {
  if (platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
  if (platform === 'darwin') {
    const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { encoding: 'utf8', shell: false, timeout: 1500 });
    return result.stdout?.match(/^n(.*)$/m)?.[1];
  }
  return undefined;
}

async function queryServerInvocation(record, {
  platform = process.platform, processQuery = queryProcess,
} = {}) {
  if (!validPid(record?.pid) || record.pid === process.pid) return null;
  const result = await processQuery(record.pid, platform);
  const commandLine = typeof result === 'string' ? result : result?.commandLine;
  if (!commandLine) return null;
  const compare = value => platform === 'win32' ? value.toLowerCase() : value;
  const execPrefix = compare(process.execPath) + ' ';
  const invocation = commandLine.match(/^(?:"[^"]*[/\\]node(?:\.exe)?"|[^\s"]*[/\\]node(?:\.exe)?|node(?:\.exe)?)\s+(.+)$/i);
  const commandArgs = compare(commandLine).startsWith(execPrefix) ? commandLine.slice(execPrefix.length) : invocation?.[1];
  if (!commandArgs) return null;

  let script = commandArgs.replace(/^--use-bundled-ca\s+/, '');
  if (record.instance) {
    const marker = ` --portable-instance=${record.instance}`;
    if (!script.endsWith(marker)) return null;
    script = script.slice(0, -marker.length);
  }
  if (script.startsWith('"') && script.endsWith('"')) script = script.slice(1, -1);
  const paths = platform === 'win32' ? path.win32 : path;
  const absolute = paths.isAbsolute(script);
  if (absolute ? compare(paths.basename(script)) !== 'server.js'
    : record.instance || !['server.js', './server.js', '.\\server.js'].includes(compare(script))) return null;
  return { script, absolute, cwd: result?.cwd, platform, compare, paths };
}

async function isProjectInvocation(invocation, record, projectDir) {
  const { script, absolute, cwd, platform, compare, paths } = invocation;
  if (absolute && compare(script) !== compare(paths.join(projectDir, 'server.js'))) return false;
  if (record.instance) return true;
  // Legacy records have no instance marker, so also verify the working directory.
  try {
    const workingDir = cwd ?? processCwd(record.pid, platform);
    return Boolean(workingDir && compare(await fs.realpath(workingDir)) === compare(await fs.realpath(projectDir)));
  } catch {
    return false;
  }
}

async function isExpectedServerProcess(record, options = {}) {
  const invocation = await queryServerInvocation(record, options);
  return Boolean(invocation && await isProjectInvocation(invocation, record, options.projectDir ?? DEFAULT_PROJECT_DIR));
}

async function isForeignManagedServerProcess(record, options = {}) {
  const invocation = await queryServerInvocation(record, options);
  // Keep a live legacy server's record if its working directory cannot be verified.
  return Boolean(invocation && !await isProjectInvocation(invocation, record, options.projectDir ?? DEFAULT_PROJECT_DIR));
}

function removeOwnedLock(lockFile, expected, checkMtime = false) {
  const current = lstatSync(lockFile, { throwIfNoEntry: false });
  if (!current || current.ino !== expected.ino || current.dev !== expected.dev ||
      (checkMtime && current.mtimeMs !== expected.mtimeMs)) return false;
  try {
    unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function reclaimStaleLock(lockFile) {
  const stat = lstatSync(lockFile, { throwIfNoEntry: false });
  if (!stat) return true;
  if (!stat.isFile()) return false;
  let record;
  try {
    record = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (!(error instanceof SyntaxError)) throw error;
  }
  const expired = validPid(record?.pid) ? !processExists(record.pid) : Date.now() - stat.mtimeMs > 1500;
  return expired && removeOwnedLock(lockFile, stat, true);
}

async function withPidLock(config, operation) {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const lockFile = config.pidFile + '.lock';
  const lockLabel = path.basename(config.dataDir) + '/server.pid.lock';
  let lock;
  const deadline = Date.now() + START_TIMEOUT_MS + 2000;
  while (!lock) {
    try {
      lock = await fs.open(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (reclaimStaleLock(lockFile)) continue;
      if (Date.now() >= deadline) throw new Error('有其他启动或停止操作正在运行；如上次异常中断，请确认后清理 ' + lockLabel);
      await delay(75);
    }
  }
  let owner;
  try {
    owner = await lock.stat();
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    return await operation();
  } finally {
    await lock.close();
    if (owner) removeOwnedLock(lockFile, owner);
  }
}

async function runningInstance(config, record, options) {
  if (record?.port && await isExpectedServerProcess(record, { ...options, projectDir: config.projectDir })) {
    const health = await probeHealth(record.host, record.port);
    if (health) return { running: true, host: record.host, port: record.port, health, pid: record.pid };
  }
  return { running: false };
}

async function statusPortable(options = {}) {
  const config = settings(options);
  const previous = await readPidRecord(config.pidFile);
  const result = await runningInstance(config, previous, options);
  if (!result.running && previous?.port &&
      await isExpectedServerProcess(previous, { ...options, projectDir: config.projectDir })) {
    return { running: false, unhealthy: true, host: previous.host, port: previous.port, pid: previous.pid };
  }
  return result;
}

function reportInstance(result, options, config) {
  const log = options.log ?? console.log;
  const url = localUrl(result.host, result.port);
  log(`AI 妙听${result.reused ? '已在运行' : '已启动'}：${url}`);
  if (result.host === '0.0.0.0' || result.host === '::') {
    for (const address of getLanAddresses()) log(`局域网：http://${address}:${result.port}`);
    log('局域网设备默认禁止删除本地历史播客（无 ADMIN_TOKEN 时删除返回 403；浏览、播放与任务生成不受影响）');
  } else if (options.lan) {
    log('当前实例未确认开启局域网监听。若需局域网试听，请先停止服务，再使用 --lan 启动。');
  }
  openBrowser(url, options, config);
  return result;
}

function launchServer(config, options, port, instance) {
  const script = path.join(config.projectDir, 'server.js');
  const args = [...(supportsBundledCa() ? ['--use-bundled-ca'] : []), script, `--portable-instance=${instance}`];
  const child = spawn(process.execPath, args, {
    cwd: config.projectDir,
    env: { ...config.env, HOST: config.host, PORT: String(port), DATA_DIR: config.dataDir, PODCASTS_DIR: config.podcastsDir },
    detached: !options.foreground,
    stdio: [...(options.foreground ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore']), 'ipc'],
    shell: false, windowsHide: true,
  });
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.on('error', () => {
      // A failed signal to a spawned child does not mean the child has exited.
      if (!child.pid) resolve(1);
    });
  });
  const listening = new Promise(resolve => child.once('message', resolve));
  const forwardSignal = () => child.kill();
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.on(signal, forwardSignal);
  const stopForwarding = () => {
    for (const signal of signals) process.removeListener(signal, forwardSignal);
  };
  return { child, exited, listening, stopForwarding };
}

async function awaitListening(server) {
  return Promise.race([server.listening, server.exited.then(() => null),
    delay(START_TIMEOUT_MS, null, { ref: false })]);
}

async function writePidRecord(pidFile, record) {
  await fs.rm(pidFile, { force: true });
  await fs.writeFile(pidFile, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
}

async function manageForeground(server, config, record) {
  try {
    const code = await server.exited;
    await withPidLock(config, async () => {
      if ((await readPidRecord(config.pidFile))?.instance === record.instance) {
        await fs.rm(config.pidFile, { force: true });
      }
    });
    return code ?? 0;
  } finally {
    server.stopForwarding();
  }
}

async function startPortable(options = {}) {
  const config = settings(options);
  const processOptions = { ...options, projectDir: config.projectDir };
  let foreground;
  const result = await withPidLock(config, async () => {
    const previous = await readPidRecord(config.pidFile);
    const current = await runningInstance(config, previous, options);
    if (current.running) {
      if (config.explicitPort && current.port !== config.port) {
        await findAvailablePort(config.host, config.port, true);
        throw new Error(`当前目录的 AI 妙听已在端口 ${current.port} 运行，请先停止后再指定新端口 ${config.port}`);
      }
      return { ...current, reused: true };
    }
    if (await isExpectedServerProcess(previous, processOptions)) {
      throw new Error('已有 AI 妙听进程，但健康检查未通过，请停止后重试');
    }
    if (await isForeignManagedServerProcess(previous, processOptions)) {
      throw new Error('当前数据目录正被另一个目录的 AI 妙听实例使用，请先停止该实例或指定独立的 --data-dir');
    }
    try {
      if (!(await fs.stat(path.join(config.projectDir, 'server.js'))).isFile()) throw new Error();
    } catch {
      throw new Error('找不到 server.js，请检查项目目录');
    }

    let candidate = config.port === 0 ? 0 : await findAvailablePort(config.host, config.port, config.explicitPort);
    for (;;) {
      const instance = randomUUID();
      const server = launchServer(config, options, candidate, instance);
      const record = {
        pid: server.child.pid, port: 0, host: config.host,
        startedAt: new Date().toISOString(), script: 'server.js', instance,
      };
      let started = false;
      try {
        const ready = await awaitListening(server);
        if (ready?.error === 'DATA_DIR_LOCKED') {
          throw new Error('当前数据目录正被另一个运行中的 AI 妙听实例占用，请先停止该实例或指定独立的 --data-dir');
        }
        if (ready?.error === 'EADDRINUSE' && candidate !== 0) {
          if (config.explicitPort) throw new Error(`指定端口 ${candidate} 已被其他服务占用，请选择其他端口`);
          candidate = candidate < DEFAULT_PORT_FALLBACK_MAX ? await findAvailablePort(config.host, candidate + 1) : 0;
          continue;
        }
        const port = ready?.port;
        if (Number.isInteger(port) && port > 0 && port <= 65535) record.port = port;
        const health = record.port && await probeHealth(config.host, record.port, 2000);
        if (!health) throw new Error('AI 妙听启动失败或超时，可用 --foreground 查看启动输出');

        await writePidRecord(config.pidFile, record);
        if (options.foreground) foreground = { server, record };
        else server.child.unref();
        started = true;
        return { running: true, reused: false, host: config.host, port, health, pid: record.pid };
      } finally {
        if (server.child.connected) server.child.disconnect();
        if (!started || !options.foreground) server.stopForwarding();
        if (!started && server.child.pid) {
          const stillAlive = () => server.child.exitCode === null && server.child.signalCode === null &&
            processExists(server.child.pid);
          for (const signal of ['SIGTERM', 'SIGKILL']) {
            if (!stillAlive()) break;
            server.child.kill(signal);
            await Promise.race([server.exited, delay(1500, undefined, { ref: false })]);
          }
          if (stillAlive()) {
            const message = '启动失败且子进程未能正常退出，请检查残余进程后重试';
            // Keep the owned PID verifiable for a later --stop, even before it has a port.
            try {
              await writePidRecord(config.pidFile, record);
            } catch (cause) {
              throw new Error(message, { cause });
            }
            server.child.unref();
            throw new Error(message);
          }
        }
      }
    }
  });

  if (foreground) result.completion = manageForeground(foreground.server, config, foreground.record);
  return reportInstance(result, options, config);
}

async function stopPortable(options = {}) {
  const config = settings(options);
  const processOptions = { ...options, projectDir: config.projectDir };
  return withPidLock(config, async () => {
    const record = await readPidRecord(config.pidFile);
    if (!await isExpectedServerProcess(record, processOptions)) {
      if (await isForeignManagedServerProcess(record, processOptions)) {
        return { stopped: false, stale: false, foreign: true };
      }
      await fs.rm(config.pidFile, { force: true });
      return { stopped: false, stale: Boolean(record) };
    }
    try {
      (options.kill ?? process.kill)(record.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw new Error('无法停止 AI 妙听进程');
      await fs.rm(config.pidFile, { force: true });
      return { stopped: false, stale: true };
    }
    const deadline = performance.now() + (process.platform === 'win32' ? 10000 : 2500);
    // Windows may still report the PID after the termination request returns.
    while (processExists(record.pid) || await isExpectedServerProcess(record, processOptions)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('AI 妙听尚未停止，请稍后重试');
      await delay(Math.min(50, remaining));
    }
    await fs.rm(config.pidFile, { force: true });
    return { stopped: true };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === 'start') {
    const result = await startPortable(options);
    if (result.completion) process.exitCode = await result.completion;
  } else if (options.action === 'stop') {
    const result = await stopPortable(options);
    if (result.foreign) console.log('当前数据目录正由另一个目录的 AI 妙听实例使用，未停止且未删除其 PID 记录');
    else console.log(result.stopped ? 'AI 妙听已停止'
      : result.stale ? 'PID 未通过校验，未终止进程，已清理过期记录' : '没有正在运行的便携启动实例');
  } else {
    const result = await statusPortable(options);
    if (result.running) console.log(`AI 妙听正在运行：${localUrl(result.host, result.port)}`);
    else if (result.unhealthy) {
      console.log(`AI 妙听进程仍在运行但健康检查未通过（PID ${result.pid}，端口 ${result.port}）`);
      process.exitCode = 2;
    } else {
      console.log('AI 妙听未在运行');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`错误：${error.code ? `启动器操作失败（${error.code}）` : error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_PORT, DEFAULT_PORT_FALLBACK_MAX,
  supportsBundledCa, probeHealth, findAvailablePort, resolveBrowserCommand, getLanAddresses,
  readPidRecord, isExpectedServerProcess, startPortable, stopPortable, statusPortable, parseArgs,
};
