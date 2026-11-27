'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { version } = require('../package.json');

const entry = require.resolve('../server');
const portOptions = { timeout: 10000 };
let root, startServer, createApp, DEFAULT_PORT, DEFAULT_PORT_FALLBACK_MAX;
let fixtureNumber = 0;
const host = '127.0.0.1';

test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-server-lifecycle-'));
  process.env.DATA_DIR = path.join(root, 'import-data');
  process.env.PODCASTS_DIR = path.join(root, 'import-audio');
  ({ startServer, createApp, DEFAULT_PORT, DEFAULT_PORT_FALLBACK_MAX } = require('../server'));
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function settings() {
  const dir = path.join(root, String(++fixtureNumber));
  return { dataDir: path.join(dir, 'data'), podcastsDir: path.join(dir, 'audio'), publicDir: path.join(dir, 'public') };
}

async function occupy(port, address) {
  const server = net.createServer();
  server.listen({ host: address, port, exclusive: true });
  await once(server, 'listening');
  return server;
}

async function occupyRange(address) {
  const servers = [];
  for (let port = DEFAULT_PORT; port <= DEFAULT_PORT_FALLBACK_MAX; port++) {
    try {
      servers.push(await occupy(port, address));
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        throw error;
      }
    }
  }
  return servers;
}

function request(port, route, { agent, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path: '/api/' + route, agent: agent ?? false,
      ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('error', reject);
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body && JSON.stringify(body));
  });
}

test('导入 server 模块不创建任务或播客目录', () => {
  assert.equal(fs.existsSync(process.env.DATA_DIR), false);
  assert.equal(fs.existsSync(process.env.PODCASTS_DIR), false);
});

test('默认首选 3456，端口冲突会顺延到下一处空闲端口', portOptions, async t => {
  assert.deepEqual([DEFAULT_PORT, DEFAULT_PORT_FALLBACK_MAX], [3456, 3475]);
  let address = '::1';
  let busy;
  try {
    busy = await occupy(DEFAULT_PORT, address);
  } catch (error) {
    if (!['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error;
    address = host;
    busy = await occupy(DEFAULT_PORT, address);
  }
  t.after(() => new Promise(resolve => busy.close(resolve)));
  let next;
  for (let port = DEFAULT_PORT + 1; port <= DEFAULT_PORT_FALLBACK_MAX; port++) {
    try {
      next = await occupy(port, address);
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  assert.ok(next, '测试需要至少一个可用的顺延端口');
  const expected = next.address().port;
  await new Promise(resolve => next.close(resolve));
  const running = await startServer({ ...settings(), host: address });
  t.after(() => running.close());
  assert.equal(running.preferredPort, 3456);
  assert.equal(running.port, expected);
  assert.equal(running.fellBack, true);
  await running.close();
  const desktop = await startServer({
    ...settings(), host: address, port: DEFAULT_PORT, allowPortFallback: true,
    maxFallbackPort: expected, allowEphemeralFallback: false,
  });
  t.after(() => desktop.close());
  assert.equal(desktop.port, expected);
});

test('默认区间占满后使用随机端口，可禁止随机降级，显式端口保持严格', portOptions, async t => {
  const servers = await occupyRange(host);
  t.after(() => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))));
  const options = { ...settings(), host };
  const fallback = await startServer(options);
  t.after(() => fallback.close());
  assert.equal(fallback.fellBack, true);
  assert.ok(fallback.port < DEFAULT_PORT || fallback.port > DEFAULT_PORT_FALLBACK_MAX);
  await fallback.close();
  await assert.rejects(startServer({ ...options, allowEphemeralFallback: false }), { code: 'EADDRINUSE' });
  await assert.rejects(startServer({ ...options, port: DEFAULT_PORT }), { code: 'EADDRINUSE' });

  const random = await startServer({ ...options, port: 0, allowPortFallback: true, allowEphemeralFallback: false });
  t.after(() => random.close());
  assert.equal(random.preferredPort, 0);
  assert.ok(random.port > 0);
  assert.equal(random.fellBack, false);
  assert.equal((await request(random.port, 'health')).body.status, 'ok');
  await random.close();
  await assert.rejects(startServer({ ...options, host: '192.0.2.1' }), { code: 'EADDRNOTAVAIL' });
});

test('应用关闭中止进行中的请求，健康及新任务请求均返回带关闭头的 503', portOptions, async t => {
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const app = createApp({
    ...settings(),
    extractor(_input, { signal }) {
      entered.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted.resolve();
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  const running = await startServer({ app, port: 0 });
  t.after(() => running.close());
  const ongoing = request(running.port, 'extract-article', { body: { rawText: '离线正文' } });
  await Promise.race([entered.promise, ongoing.then(() => assert.fail('请求应保持进行中'))]);
  const closing = app.shutdown();
  assert.equal(app.shutdown(), closing);
  await closing;
  await aborted.promise;
  assert.equal((await ongoing).status, 503);
  const health = await request(running.port, 'health?probe=1');
  assert.equal(health.status, 503);
  assert.equal(health.headers.connection, 'close');
  assert.deepEqual(health.body, { status: 'shutting_down', app: 'ai-podcast-generator', version });
  for (const endpoint of ['tasks', 'tasks/test/resume']) {
    const result = await request(running.port, endpoint, { body: {} });
    assert.equal(result.status, 503);
    assert.equal(result.headers.connection, 'close');
    assert.equal(result.body.code, 'SERVER_SHUTTING_DOWN');
  }
});

test('close 立即释放空闲长连接，幂等并在超时后强制关闭未完成连接', portOptions, async t => {
  const entered = Promise.withResolvers();
  const endExtractor = Promise.withResolvers();
  const running = await startServer({
    ...settings(), port: 0, extractor() {
      entered.resolve();
      return endExtractor.promise;
    },
  });
  t.after(() => running.close({ timeoutMs: 100 }));
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const idle = once(agent, 'free');
  assert.equal((await request(running.port, 'health', { agent })).status, 200);
  const [socket] = await idle;
  const idleClosed = once(socket, 'close');
  const hung = request(running.port, 'extract-article', { body: { rawText: '等待强制关闭' } });
  const dropped = assert.rejects(hung, { code: 'ECONNRESET' });
  await Promise.race([entered.promise, dropped.then(() => assert.fail('连接应保持进行中'))]);
  const closing = running.close({ timeoutMs: 500 });
  assert.equal(running.close(), closing);
  await Promise.race([idleClosed, closing.then(() => assert.fail('空闲连接应先于关闭期限释放'))]);
  await closing;
  await dropped;
  endExtractor.resolve({ content: '检查未响应的路由' });
});

function launch(t, port, options = settings()) {
  const cwd = path.dirname(options.dataDir);
  fs.mkdirSync(cwd, { recursive: true });
  const child = fork(entry, ['--portable-instance=lifecycle-test'], {
    cwd, silent: true, execArgv: [],
    env: { ...process.env, HOST: host, PORT: String(port), DATA_DIR: options.dataDir, PODCASTS_DIR: options.podcastsDir },
  });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  });
  child.stdout.resume();
  child.stderr.resume();
  const ready = Promise.race([
    once(child, 'message').then(([message]) => message),
    exit.then(() => assert.fail('退出前未收到 IPC 启动结果')),
  ]);
  return { child, ready, exit };
}

test('CLI 按 IPC 报告显式 PORT 冲突，PORT=0 启动后收到 SIGTERM 干净退出', {
  timeout: 10000, skip: process.platform === 'win32' && 'Windows 不会交付可捕获的 SIGTERM',
}, async t => {
  const occupied = await occupy(0, host);
  t.after(() => new Promise(resolve => occupied.close(resolve)));

  const rejected = launch(t, occupied.address().port);
  assert.deepEqual(await rejected.ready, { error: 'EADDRINUSE' });
  assert.deepEqual(await rejected.exit, [1, null]);
  const running = launch(t, 0);
  const { port } = await running.ready;
  assert.ok(port > 0);
  assert.equal((await request(port, 'health')).status, 200);
  const watchdog = new AbortController();
  running.child.kill('SIGTERM');
  try {
    assert.deepEqual(await Promise.race([
      running.exit,
      delay(2500, undefined, { signal: watchdog.signal }).then(() => assert.fail('SIGTERM 退出超时')),
    ]), [0, null]);
  } finally {
    watchdog.abort();
  }
});

test('同进程与独立 CLI 都无法抢占运行中任务，关闭后可重新启动', portOptions, async t => {
  const options = settings();
  const entered = Promise.withResolvers();
  const first = await startServer({
    ...options, port: 0, scriptGenerator({ signal }) {
      entered.resolve();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  t.after(() => first.close());
  const created = await request(first.port, 'tasks', { body: {
    mode: 'text', content: '离线任务正文', apiKey: 'offline', baseURL: 'https://fixture.example',
  } });
  assert.equal(created.status, 202);
  await entered.promise;
  const id = created.body.data.id;
  const file = path.join(options.dataDir, 'tasks', id + '.json');
  const checkpoint = fs.readFileSync(file);
  assert.equal(JSON.parse(checkpoint).status, 'running');
  const alias = path.join(path.dirname(options.dataDir), 'alias');
  fs.symlinkSync(options.dataDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(startServer({ ...options, dataDir: alias, port: first.port, allowPortFallback: true }), {
    code: 'DATA_DIR_LOCKED',
  });
  await assert.rejects(startServer({ app: createApp(options), port: 0 }), { code: 'DATA_DIR_LOCKED' });
  const standalone = createApp({ ...options, dataDir: alias }).listen(0, host);
  t.after(() => new Promise(resolve => standalone.close(resolve)));
  await once(standalone, 'listening');
  const refused = await request(standalone.address().port, 'health');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'DATA_DIR_LOCKED');
  assert.deepEqual(fs.readFileSync(file), checkpoint);
  const other = launch(t, 0, options);
  assert.deepEqual(await other.ready, { error: 'DATA_DIR_LOCKED' });
  assert.deepEqual(await other.exit, [1, null]);
  assert.deepEqual(fs.readFileSync(file), checkpoint);
  assert.equal((await request(first.port, 'tasks/' + id)).body.data.status, 'running');
  await first.close();
  const next = await startServer({ ...options, port: 0 });
  t.after(() => next.close());
  assert.equal((await request(next.port, 'health')).status, 200);
});

test('回收已退出进程遗留的锁，关闭时保留其他所有者的替换锁', portOptions, async t => {
  const options = settings();
  const child = launch(t, 0, options);
  assert.ok((await child.ready).port > 0);
  const standalone = createApp(options).listen(0, host);
  t.after(() => new Promise(resolve => standalone.close(resolve)));
  await once(standalone, 'listening');
  const refused = await request(standalone.address().port, 'health');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'DATA_DIR_LOCKED');
  child.child.kill('SIGKILL');
  await child.exit;
  const lock = path.join(options.dataDir, '.server.lock');
  assert.equal(JSON.parse(fs.readFileSync(lock)).pid, child.child.pid);
  const next = await startServer({ ...options, port: 0 });
  t.after(() => next.close());
  assert.equal(JSON.parse(fs.readFileSync(lock)).pid, process.pid);
  fs.renameSync(lock, lock + '.previous');
  fs.writeFileSync(lock, 'replacement');
  await next.close();
  assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement');
});

test('多个 CLI 同时回收死进程的锁时只有一个实例进入监听', portOptions, async t => {
  const options = settings();
  const previous = launch(t, 0, options);
  assert.ok((await previous.ready).port > 0);
  previous.child.kill('SIGKILL');
  await previous.exit;
  const contenders = Array.from({ length: 3 }, () => launch(t, 0, options));
  const results = await Promise.all(contenders.map(child => child.ready));
  const winners = results.filter(message => message.port > 0);
  assert.equal(winners.length, 1);
  assert.equal(results.filter(message => message.error === 'DATA_DIR_LOCKED').length, 2);
  assert.equal((await request(winners[0].port, 'health')).status, 200);
});
