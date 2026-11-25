'use strict';
/**
 * B-F1 / B-F2：适配层生命周期与产物发布回归（全离线）。
 *
 * B-F1（子进程级）：「接受 TCP 但永不完成 WS 握手」+ connect 超时 / 取消两种场景，
 * 必须以 Promise 明确拒绝收场、不留下任何文件、不留下未关闭连接，且进程正常退出——
 * 未捕获的 ws 'error'（removeAllListeners 后 terminate 的经典崩溃）会令 Node 非零退出使断言失败。
 *
 * B-F1（进程内）：发布（原子 rename）失败必须 settle 拒绝而非悬挂/误发布；建立连接后取消不留下产物。
 *
 * B-F2：fake TTS 只发送截断 MP3 后跟 turn.end 时，产物校验必须拒绝发布。
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EdgeTtsAdapter, TtsCancelledError } = require('../src/services/edgeTtsAdapter');
const { startFakeEdgeTts } = require('./fakeEdgeTts');
const { makeMp3 } = require('./helpers/mp3Fixtures');

const CHILD = path.join(__dirname, 'helpers', 'handshakeHangChild.js');

const FAST_TIMEOUTS = {
  connectTimeoutMs: 500,
  firstDataTimeoutMs: 250,
  idleTimeoutMs: 250,
  taskTimeoutMs: 3000,
};

function makeAdapter(endpoint, overrides = {}) {
  return new EdgeTtsAdapter({
    voice: 'zh-CN-YunxiNeural',
    endpoint,
    ...FAST_TIMEOUTS,
    ...overrides,
  });
}

/** 给 Promise 套超时保险：生命周期 bug 的典型症状就是 Promise 永不 settle */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未 settle`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function runChild(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-handshake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return spawnSync(process.execPath, [CHILD, mode], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, TMPDIR: dir },
  });
}

test('B-F1：握手停在 CONNECTING 时 connect 超时——进程正常退出、明确拒绝、无残留', t => {
  const r = runChild(t, 'timeout');
  assert.strictEqual(
    r.status,
    0,
    `子进程应正常退出（无未捕获异常），实际 status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`
  );
  assert.match(r.stdout, /REJECTED_OK/);
});

test('B-F1：握手停在 CONNECTING 时取消——进程正常退出、明确拒绝、无残留', t => {
  const r = runChild(t, 'cancel');
  assert.strictEqual(
    r.status,
    0,
    `子进程应正常退出（无未捕获异常），实际 status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`
  );
  assert.match(r.stdout, /REJECTED_OK:TtsCancelledError/);
});

test('B-F1：发布（原子 rename）失败必须 settle 拒绝，不悬挂不误发布', async t => {
  const payload = makeMp3(10);
  const fake = await startFakeEdgeTts({ mode: 'ok', payload });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf1-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'sentence_000.mp3');
  fs.mkdirSync(target); // 目标位置被目录占住 → renameSync 必失败
  try {
    await assert.rejects(
      withTimeout(makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target), 3000, 'publish-fail')
    );
  } finally {
    await fake.close();
  }
});

test('B-F1：连接建立后取消——拒绝为 TtsCancelledError 且不留下产物', async t => {
  const payload = makeMp3(10);
  const fake = await startFakeEdgeTts({ mode: 'late', payload, delayMs: 600 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf1-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'sentence_000.mp3');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(
      withTimeout(
        makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target, { signal: controller.signal }),
        3000,
        'cancel-open'
      ),
      (e) => e instanceof TtsCancelledError
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(!fs.existsSync(target), '取消后不应发布产物');
    assert.ok(
      fs.readdirSync(path.dirname(target)).every((f) => !f.includes('.tmp-')),
      '取消后不应留下临时文件'
    );
  } finally {
    await fake.close();
  }
});

test('B-F2：fake TTS 只发截断 MP3 + turn.end——产物校验拒绝发布', async t => {
  const payload = makeMp3(10);
  const fake = await startFakeEdgeTts({ mode: 'truncated-mp3', payload });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf2-trunc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'sentence_000.mp3');
  try {
    await assert.rejects(
      withTimeout(makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target), 3000, 'truncated'),
      (e) => /不是完整有效的 MP3/.test(e.message)
    );
    assert.ok(!fs.existsSync(target), '残缺 MP3 不得发布');
    assert.strictEqual(fs.readdirSync(dir).length, 0, '不应留下临时文件');
  } finally {
    await fake.close();
  }
});
