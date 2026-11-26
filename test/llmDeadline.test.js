'use strict';
/**
 * B-F4（清单外新发现）：LLM / 抓取的超时定时器不得泄漏。
 * 复现缺陷：axios 的 timeout 选项在连接阶段失败（如拒绝连接）时，其内部
 * connectPhaseTimer 不会被清理，会挟持事件循环到满 timeout 时长——
 * 180 秒的剧本超时使整个测试进程多存活 180 秒。
 * 断言方式：子进程完成两次失败调用后自然排空事件循环，父进程用单调时钟计时。
 * （隔离子进程，仍为全离线：只连接 127.0.0.1:9 死端口。）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defaultFetcher } = require('../src/services/extractor');

const CHILD = path.join(__dirname, 'helpers', 'llmFailChild.js');

test('B-F4：LLM/抓取连接失败后不残留超时定时器（子进程 5s 内自然退出）', () => {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CHILD, 'run'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  const elapsed = performance.now() - t0;
  assert.strictEqual(r.status, 0, `子进程应自然退出，status=${r.status}，stderr=${r.stderr}`);
  assert.match(r.stdout, /LLM_REJECTED/);
  assert.match(r.stdout, /FETCH_REJECTED/);
  // 给并发 CI 中的 Node 冷启动和两次 ECONNREFUSED 留出 5 秒；
  // 残留的 8 秒定时器仍会使子进程超过阈值。
  assert.ok(elapsed < 5000, `失败后进程应在 5s 内退出（无残留定时器），实际 ${elapsed}ms`);
});

test('B-F4：单跳抓取超时经自管 AbortSignal 触发并报超时错误（假传输）', async () => {
  const request = (url, cfg) =>
    new Promise((_, reject) => {
      cfg.signal.addEventListener('abort', () => reject(new Error('请求被中止')));
    });
  await assert.rejects(
    defaultFetcher('https://article.example.com/hang', {}, { request, timeoutMs: 80 }),
    (e) => e.statusCode === 502 && /超时/.test(e.message)
  );
});

test('B-F4：单跳未超时的请求正常完成且定时器被清理（假传输）', async () => {
  const request = async (url, cfg) => {
    assert.ok(cfg.signal instanceof AbortSignal);
    return { status: 200, headers: {}, data: '<html>正文</html>' };
  };
  const r = await defaultFetcher('https://article.example.com/ok', {}, { request, timeoutMs: 5000 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data, '<html>正文</html>');
});
