'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { ChildProcess, execFile, spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const {
  supportsBundledCa, probeHealth, findAvailablePort, resolveBrowserCommand, getLanAddresses,
  readPidRecord, isExpectedServerProcess, startPortable, stopPortable, statusPortable, parseArgs,
} = require('../scripts/start-portable');
const { version } = require('../package.json');

const PROJECT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(PROJECT, 'scripts/start-portable.js');
const exec = promisify(execFile);

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

function fixture(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast launcher '));
  for (const file of ['server.js', 'package.json', 'src']) {
    fs.cpSync(path.join(PROJECT, file), path.join(projectDir, file), { recursive: true });
  }
  const dataDir = path.join(projectDir, 'offline-data');
  const podcastsDir = path.join(projectDir, 'offline-audio');
  const env = { ...process.env, NODE_PATH: path.join(PROJECT, 'node_modules'), CI: 'true', HOST: '', PORT: '' };
  const messages = [];
  const options = { projectDir, dataDir, podcastsDir, env, log: message => messages.push(message) };
  t.after(async () => {
    try {
      await stopPortable(options);
    } finally {
      await removeDirWithBudget(projectDir);
    }
  });
  return { options, messages, pidFile: path.join(dataDir, 'server.pid') };
}

async function listen(port, body, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.listen({ host, port, exclusive: true });
  await once(server, 'listening');
  return server;
}

test('便携启动参数与运行时 CA 能力检测', () => {
  assert.deepEqual(parseArgs(['--open', '--no-open', '--lan', '--foreground', '--port', '0',
    '--host', 'localhost', '--project-dir', 'copy', '--data-dir', 'state', '--podcasts-dir', 'audio']), {
    action: 'start', open: false, lan: true, foreground: true, port: 0,
    host: 'localhost', projectDir: 'copy', dataDir: 'state', podcastsDir: 'audio',
  });
  assert.equal(parseArgs(['--status']).action, 'status');
  assert.equal(parseArgs(['--stop']).action, 'stop');
  assert.throws(() => parseArgs(['--stop', '--status']), /不能同时/);
  assert.throws(() => parseArgs(['--port', '--open']), /缺少 --port/);
  assert.throws(() => parseArgs(['--port', '65536']), /端口/);
  assert.throws(() => parseArgs(['--unknown']), /无法识别/);
  assert.equal(supportsBundledCa(new Set(['--use-bundled-ca'])), true);
  assert.equal(supportsBundledCa(undefined), process.allowedNodeEnvironmentFlags.has('--use-bundled-ca'));
  assert.equal(supportsBundledCa(null), false);
});

test('只将通过校验的本机和局域网 URL 传给系统浏览器命令', () => {
  const url = 'http://127.0.0.1:3000';
  assert.deepEqual(resolveBrowserCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(resolveBrowserCommand(url, 'win32'), { command: 'cmd.exe', args: ['/c', 'start', '', url] });
  assert.deepEqual(resolveBrowserCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
  for (const allowed of ['https://localhost:4000', 'http://10.0.0.4', 'http://172.31.2.3', 'http://192.168.0.9']) {
    assert.deepEqual(resolveBrowserCommand(allowed, 'win32').args.at(-1), allowed);
  }
  for (const invalid of ['file:///tmp/example', 'http://public.example', 'http://172.32.0.1',
    'http://2130706433', 'http://127.0.0.1@192.168.0.1', 'http://127.0.0.1:65536', 'http://127.0.0.1 x',
    'http://127.0.0.1/?a=1&b=2', 'http://127.0.0.1/%22', 'http://127.0.0.1/|echo',
    'http://127.0.0.1/^', 'http://127.0.0.1/!', 'http://127.0.0.1/;echo', 'http://127.0.0.1\\example']) {
    assert.throws(() => resolveBrowserCommand(invalid, 'win32', []), /地址|URL/);
  }
  assert.deepEqual(getLanAddresses({
    lo: [{ address: '127.0.0.1', internal: true }],
    wifi: [{ address: '192.168.0.9', internal: false }, { address: '::1', internal: false }],
    other: [{ address: '192.168.0.9', internal: false }, { address: '10.1.1.3', internal: false }],
  }), ['192.168.0.9', '10.1.1.3']);
});

test('实际启动、读取健康版本、并发复用、查询并安全停止', async t => {
  const { options, pidFile, messages } = fixture(t);
  const [first, second] = await Promise.all([
    startPortable({ ...options, open: true }),
    startPortable({ ...options, open: true }),
  ]);
  assert.ok(first.port > 0);
  assert.equal(first.port, second.port);
  assert.equal(first.pid, second.pid);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
  assert.ok(messages.some(message => message.includes('已在运行')));
  const record = await readPidRecord(pidFile);
  assert.equal(record.pid, first.pid);
  assert.equal(record.port, first.port);
  assert.equal(record.host, '127.0.0.1');
  assert.equal(record.script, 'server.js');
  assert.ok(Number.isFinite(Date.parse(record.startedAt)));

  const res = await fetch('http://127.0.0.1:' + first.port + '/api/health');
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.app, 'ai-podcast-generator');
  assert.equal(health.version, version);
  assert.ok(Number.isFinite(Date.parse(health.time)));
  assert.equal((await statusPortable(options)).pid, record.pid);
  assert.equal((await startPortable({ ...options, port: record.port })).reused, true);
  assert.equal((await stopPortable(options)).stopped, true);
  assert.equal(await readPidRecord(pidFile), null);
  assert.equal(await probeHealth('127.0.0.1', first.port), null);
});

test('独立 CLI 子进程退出后，后台服务仍可查询和停止', async t => {
  const { options } = fixture(t);
  const args = [LAUNCHER, '--project-dir', options.projectDir, '--data-dir', options.dataDir,
    '--podcasts-dir', options.podcastsDir];
  const run = (...tail) => exec(process.execPath, [...args, ...tail], { env: options.env, timeout: 20000 });
  assert.match((await run('--port', '0', '--no-open')).stdout, /已启动/);
  assert.match((await run('--status')).stdout, /正在运行/);
  assert.match((await run('--stop')).stdout, /已停止/);
  await assert.rejects(run('--status'), { code: 1 });
});

test('受管服务返回 HTTP 503 时状态退出码为 2，仍可停止', async t => {
  const { options, pidFile } = fixture(t);
  const healthFlag = path.join(options.dataDir, 'health-unavailable');
  fs.writeFileSync(path.join(options.projectDir, 'server.js'), [
    'const { createServer } = require("node:http");',
    'const { existsSync } = require("node:fs");',
    'const { join } = require("node:path");',
    'const server = createServer((_request, response) => {',
    '  response.statusCode = existsSync(join(process.env.DATA_DIR, "health-unavailable")) ? 503 : 200;',
    '  response.end(JSON.stringify({ app: "ai-podcast-generator", status: "ok" }));',
    '});',
    'server.listen(Number(process.env.PORT), process.env.HOST, () => process.send({ port: server.address().port }));',
  ].join('\n'));
  const { host, port, pid } = await startPortable({ ...options, port: 0 });
  fs.writeFileSync(healthFlag, '');
  const response = await fetch(`http://${host}:${port}/api/health`);
  assert.equal(response.status, 503);
  await response.text();

  const args = [LAUNCHER, '--project-dir', options.projectDir, '--data-dir', options.dataDir];
  const run = action => exec(process.execPath, [...args, action], { env: options.env, timeout: 20000 });
  assert.deepEqual(await statusPortable(options), { running: false, unhealthy: true, host, port, pid });
  await assert.rejects(run('--status'), {
    code: 2,
    stdout: `AI 妙听进程仍在运行但健康检查未通过（PID ${pid}，端口 ${port}）\n`,
  });
  assert.equal((await run('--stop')).stdout.trim(), 'AI 妙听已停止');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(pidFile), false);
});

test('停止时即使命令行已不可查询，也等待受管 PID 退出', async t => {
  const { options, pidFile } = fixture(t);
  await startPortable({ ...options, port: 0 });
  const { pid, instance } = await readPidRecord(pidFile);
  const commandLine = `"${process.execPath}" "${path.join(options.projectDir, 'server.js')}" --portable-instance=${instance}`;
  let termination;
  try {
    const result = await stopPortable({
      ...options,
      processQuery: () => termination ? null : commandLine,
      kill: (pid, signal) => {
        termination = delay(200).then(() => process.kill(pid, signal));
      },
    });
    assert.equal(result.stopped, true);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(await readPidRecord(pidFile), null);
  } finally {
    await termination;
  }
});

test('启动失败返回前等待刚启动的子进程退出', async t => {
  const { options } = fixture(t);
  const childPidFile = path.join(options.dataDir, 'failed-child.pid');
  fs.writeFileSync(path.join(options.projectDir, 'server.js'), [
    'const { writeFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    'writeFileSync(join(process.env.DATA_DIR, "failed-child.pid"), String(process.pid));',
    'process.send({ port: 0 });',
    'setTimeout(() => {}, 5000);',
  ].join('\n'));
  await assert.rejects(startPortable({ ...options, port: 0 }), /AI 妙听启动失败或超时/);
  const pid = Number(fs.readFileSync(childPidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('启动超时后强制清理忽略 SIGTERM 的子进程', async t => {
  const { options, pidFile } = fixture(t);
  const childPidFile = path.join(options.dataDir, 'unresponsive-child.pid');
  fs.writeFileSync(path.join(options.projectDir, 'server.js'), [
    'const { writeFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    'process.on("SIGTERM", () => {});',
    'writeFileSync(join(process.env.DATA_DIR, "unresponsive-child.pid"), String(process.pid));',
    'setTimeout(() => {}, 15000);',
  ].join('\n'));
  const kill = t.mock.method(ChildProcess.prototype, 'kill');
  await assert.rejects(startPortable({ ...options, port: 0 }), /AI 妙听启动失败或超时/);
  const pid = Number(fs.readFileSync(childPidFile, 'utf8'));
  assert.ok(pid > 0);
  const signals = kill.mock.calls.filter(call => call.this.pid === pid).map(call => call.arguments[0]);
  assert.equal(signals[0], 'SIGTERM');
  // On Windows the first signal already terminates the process.
  if (process.platform !== 'win32') assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(pidFile), false);
});

test('两次信号均未结束启动失败的进程时保留可停止的 PID 记录', async t => {
  const { options, pidFile } = fixture(t);
  fs.writeFileSync(path.join(options.projectDir, 'server.js'), [
    'process.send({ port: 0 });',
    'setTimeout(() => {}, 8000);',
  ].join('\n'));
  t.mock.method(ChildProcess.prototype, 'kill', () => true);
  await assert.rejects(startPortable({ ...options, port: 0 }), /启动失败且子进程未能正常退出/);
  const record = await readPidRecord(pidFile);
  assert.equal(record.port, 0);
  assert.equal(await isExpectedServerProcess(record, options), true);
  assert.equal((await stopPortable(options)).stopped, true);
  assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(pidFile), false);
});

test('默认端口被其他服务占用时自动顺延', async t => {
  let other;
  for (const host of ['127.0.0.1', '::1', '127.0.0.2']) {
    try {
      other = await listen(3000, { status: 'ok', app: 'other-service' }, host);
      break;
    } catch (error) {
      if (!['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error;
    }
  }
  if (!other) return t.skip('本机没有可隔离的 3000 回环端口');
  const host = other.address().address;
  t.after(() => new Promise(resolve => other.close(resolve)));
  const { options } = fixture(t);
  const expectedPort = await findAvailablePort(host);
  const result = await startPortable({ ...options, host });
  assert.notEqual(result.port, 3000);
  if (expectedPort <= 3020) assert.equal(result.port, expectedPort);
  assert.equal((await statusPortable(options)).port, result.port);
  assert.equal(await probeHealth(host, 3000), null);
});

test('显式 --port、PORT 和 .env 中的 PORT 被占用时报错', async t => {
  const other = await listen(0, { status: 'ok' });
  t.after(() => new Promise(resolve => other.close(resolve)));
  const { options, pidFile } = fixture(t);
  const port = other.address().port;
  await assert.rejects(startPortable({ ...options, port }), /指定端口 \d+ 已被其他服务占用/);
  await assert.rejects(exec(process.execPath, [
    LAUNCHER, '--project-dir', options.projectDir, '--data-dir', options.dataDir, '--no-open',
  ], { env: { ...options.env, PORT: String(port) }, timeout: 20000 }), {
    code: 1, stderr: /指定端口 \d+ 已被其他服务占用/,
  });
  fs.writeFileSync(path.join(options.projectDir, '.env'), 'PORT=' + port + '\n');
  const { PORT, ...env } = options.env;
  await assert.rejects(startPortable({ ...options, env }), /指定端口 \d+ 已被其他服务占用/);
  assert.equal(await readPidRecord(pidFile), null);
});

test('已有受管实例时，显式指定其他端口会报告占用或要求先停止', async t => {
  const { options } = fixture(t);
  const current = await startPortable({ ...options, port: 0 });
  const other = await listen(0, { status: 'ok' });
  t.after(() => new Promise(resolve => other.close(resolve)));
  const busy = other.address().port;
  const args = [LAUNCHER, '--project-dir', options.projectDir, '--data-dir', options.dataDir,
    '--port', String(busy)];
  await assert.rejects(exec(process.execPath, args, { env: options.env, timeout: 20000 }), {
    code: 1, stderr: new RegExp('指定端口 ' + busy + ' 已被其他服务占用'),
  });
  await assert.rejects(startPortable({ ...options, env: { ...options.env, PORT: String(busy) } }),
    new RegExp('指定端口 ' + busy + ' 已被其他服务占用'));
  const available = await findAvailablePort('127.0.0.1', 0, true);
  await assert.rejects(startPortable({ ...options, port: available }),
    new RegExp('已在端口 ' + current.port + ' 运行，请先停止后再指定新端口 ' + available));
  assert.equal((await statusPortable(options)).pid, current.pid);
});

test('不同项目目录各自管理实例，即使健康检查的应用标识相同', async t => {
  const a = fixture(t);
  const b = fixture(t);
  const first = await startPortable({ ...a.options, port: 0 });
  assert.deepEqual(await statusPortable({ ...b.options, port: first.port }), { running: false });
  await assert.rejects(startPortable({ ...b.options, port: first.port }), /指定端口 \d+ 已被其他服务占用/);
  const second = await startPortable(b.options);
  assert.equal(second.reused, false);
  assert.notEqual(second.port, first.port);
  assert.notEqual(second.pid, first.pid);
  assert.equal((await stopPortable(b.options)).stopped, true);
  assert.equal(await probeHealth(second.host, second.port), null);
  assert.equal((await statusPortable(a.options)).pid, first.pid);
  assert.ok(await probeHealth(first.host, first.port));
});

test('共享数据目录时另一个安装目录的启动和停止命令都保留原 PID 文件', async t => {
  const a = fixture(t);
  const b = fixture(t);
  const first = await startPortable({ ...a.options, port: 0 });
  const original = fs.readFileSync(a.pidFile, 'utf8');
  const shared = { ...b.options, dataDir: a.options.dataDir };
  const cli = (options, ...args) => exec(process.execPath, [
    LAUNCHER, '--project-dir', options.projectDir, '--data-dir', options.dataDir, ...args,
  ], { env: options.env, timeout: 20000 });

  await assert.rejects(cli(shared, '--port', String(first.port)), {
    code: 1, stderr: /当前数据目录正被另一个目录的 AI 妙听实例使用/,
  });
  assert.equal(fs.readFileSync(a.pidFile, 'utf8'), original);
  assert.match((await cli(a.options, '--status')).stdout, /AI 妙听正在运行/);
  assert.deepEqual(await stopPortable(shared), { stopped: false, stale: false, foreign: true });
  assert.equal((await cli(shared, '--stop')).stdout.trim(),
    '当前数据目录正由另一个目录的 AI 妙听实例使用，未停止且未删除其 PID 记录');
  assert.equal(fs.readFileSync(a.pidFile, 'utf8'), original);
  assert.match((await cli(a.options, '--status')).stdout, /AI 妙听正在运行/);
  assert.equal((await statusPortable(a.options)).pid, first.pid);
});

test('启动前置校验失败时保留过期的 PID 文件', async t => {
  const { options, pidFile } = fixture(t);
  const other = await listen(0, { status: 'ok' });
  t.after(() => new Promise(resolve => other.close(resolve)));
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal((await once(dead, 'exit'))[0], 0);
  const original = String(dead.pid) + '\n';
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, original);

  await assert.rejects(startPortable({ ...options, projectDir: path.join(options.projectDir, 'missing') }), /找不到 server\.js/);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), original);
  await assert.rejects(startPortable({ ...options, port: other.address().port }), /指定端口 \d+ 已被其他服务占用/);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), original);
});

test('停止拒绝误杀无关 PID，并兼容核验旧数字记录', async t => {
  const { options, pidFile } = fixture(t);
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'server.js'], { stdio: 'ignore' });
  const gone = once(other, 'close');
  t.after(async () => {
    other.kill();
    await gone;
  });
  await once(other, 'spawn');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(other.pid));
  const record = await readPidRecord(pidFile);
  assert.deepEqual(record, { pid: other.pid, script: 'server.js' });
  assert.equal(await isExpectedServerProcess(record, { projectDir: options.projectDir }), false);
  assert.equal(await isExpectedServerProcess(record, {
    projectDir: options.projectDir, processQuery: () => ({ commandLine: 'node server.js', cwd: options.projectDir }),
  }), true);
  assert.equal(await isExpectedServerProcess(record, {
    platform: 'win32', projectDir: 'C:\\Example Suite\\Podcast',
    processQuery: () => '"C:\\Program Files\\nodejs\\node.exe" "C:\\Example Suite\\Podcast\\server.js"',
  }), false, '旧记录必须能核验工作目录');
  const instance = '5fcb6a5c-8ecb-4027-8da4-0fbe16cf609c';
  assert.equal(await isExpectedServerProcess({ ...record, instance }, {
    platform: 'win32', projectDir: 'C:\\Example Suite\\Podcast',
    processQuery: () => '"C:\\Program Files\\nodejs\\node.exe" "C:\\Example Suite\\Podcast\\server.js" --portable-instance=' + instance,
  }), true);
  const absoluteCommand = 'node ' + path.join(options.projectDir, 'server.js');
  assert.equal(await isExpectedServerProcess(record, {
    projectDir: options.projectDir,
    processQuery: () => ({ commandLine: absoluteCommand, cwd: PROJECT }),
  }), false, '同一个绝对脚本路径在其他工作目录启动的进程不归当前目录管理');
  assert.equal(await isExpectedServerProcess(record, {
    projectDir: options.projectDir,
    processQuery: () => ({ commandLine: absoluteCommand, cwd: options.projectDir }),
  }), true);
  assert.equal(await isExpectedServerProcess(record, {
    projectDir: options.projectDir, processQuery: () => 'other /somewhere/node ' + path.join(options.projectDir, 'server.js'),
  }), false);
  assert.deepEqual(await stopPortable(options), { stopped: false, stale: true });
  assert.equal(await readPidRecord(pidFile), null);
  assert.equal(other.kill(0), true);

  fs.writeFileSync(pidFile, '2147483647');
  assert.deepEqual(await stopPortable({
    ...options, processQuery: () => null, kill: () => assert.fail('不得向过期 PID 发信号'),
  }), { stopped: false, stale: true });
  assert.equal(fs.existsSync(pidFile), false);
});

test('过期空锁和已退出进程的锁自动回收', async t => {
  const { options, pidFile } = fixture(t);
  const lock = pidFile + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 2000);
  fs.utimesSync(lock, old, old);
  const instance = await startPortable({ ...options, port: 0 });
  assert.equal(fs.existsSync(lock), false);

  const finished = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal((await once(finished, 'exit'))[0], 0);
  fs.writeFileSync(lock, JSON.stringify({ pid: finished.pid, startedAt: new Date().toISOString() }));
  assert.equal((await startPortable(options)).pid, instance.pid);
  assert.equal(fs.existsSync(lock), false);

});

test('活进程持有的锁超龄后仍不可回收，超时提示实际数据子目录名', { timeout: 16000 }, async t => {
  const { options, pidFile } = fixture(t);
  const lock = pidFile + '.lock';
  const record = JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 60000).toISOString() });
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, record);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  try {
    await assert.rejects(stopPortable(options), /有其他启动或停止操作正在运行.*offline-data\/server\.pid\.lock/);
    assert.equal(fs.readFileSync(lock, 'utf8'), record);
  } finally {
    fs.rmSync(lock, { force: true });
  }
});

test('四个原生启动器换行与权限，三份 Shell 脚本语法检查', () => {
  const windowsBash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  const bash = process.platform === 'win32' && fs.existsSync(windowsBash) ? windowsBash : 'bash';
  const files = ['scripts/build-mac-launcher.sh'];
  for (const action of ['start', 'stop']) {
    const bat = fs.readFileSync(path.join(PROJECT, 'scripts/launchers/' + action + '-windows.bat'), 'utf8');
    assert.ok(bat.startsWith('@echo off\r\nchcp 65001 >nul\r\n'));
    assert.doesNotMatch(bat.replace(/\r\n/g, ''), /[\r\n]/);
    const command = 'scripts/launchers/' + action + '-macos.command';
    const filename = path.join(PROJECT, command);
    const shell = fs.readFileSync(filename, 'utf8');
    assert.match(shell, /^#!\/bin\/bash\n/);
    assert.doesNotMatch(shell, /\r/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o755);
    files.push(command);
  }
  for (const file of files) {
    const result = spawnSync(bash, ['-n', file], { cwd: PROJECT, shell: false, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
});
