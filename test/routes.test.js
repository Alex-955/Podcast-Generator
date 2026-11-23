'use strict';
/**
 * B-D1：路由级契约与错误语义冒烟（全离线，不碰公网）。
 *
 * 覆盖：
 * - 只读路由的基本形状（health / voices / bgm-list）；
 * - 用户输入错误必须 400（extract-article 空输入、generate-script 原文是链接、
 *   synthesize-podcast 非法行/超限行）——非法行不得再被 normalizeDialogue 静默丢弃；
 * - LLM 调用失败 / 模型输出超限必须 502（死 baseURL、本地 fake LLM 返超限对话 / 非 JSON）；
 * - 缺少 API Key 属输入问题 400，不冒充上游错误。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../server');

let server;
let base;
let llmServer;
let llmBase;
let llmReply;

test.before(async () => {
  // 本地 fake LLM：OpenAI 兼容形态，应答内容由 llmReply 控制
  llmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(llmReply));
    });
  });
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  llmBase = `http://127.0.0.1:${llmServer.address().port}`;

  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => llmServer.close(r));
});

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('GET /api/health 基本形状', async () => {
  const { status, json } = await get('/api/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.status, 'ok');
});

test('GET /api/voices 返回顶层 voices 与 defaultMapping', async () => {
  const { status, json } = await get('/api/voices');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, true);
  assert.ok(Array.isArray(json.voices) && json.voices.length > 0, 'voices 应为非空数组');
  assert.ok(json.defaultMapping && typeof json.defaultMapping === 'object', 'defaultMapping 应为对象');
  assert.ok(json.defaultMapping['阿泽'] && json.defaultMapping['小晓'], '默认映射应包含两位主播');
});

test('GET /api/bgm-list 返回顶层 bgmList', async () => {
  const { status, json } = await get('/api/bgm-list');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, true);
  assert.ok(Array.isArray(json.bgmList) && json.bgmList.length > 0, 'bgmList 应为非空数组');
});

test('extract-article 空输入按用户输入错误 400', async () => {
  const { status, json } = await post('/api/extract-article', {});
  assert.strictEqual(status, 400);
  assert.strictEqual(json.success, false);
  assert.strictEqual(typeof json.error, 'string');
});

test('generate-script 原文是链接时 400（拦截裸链接当正文）', async () => {
  const { status, json } = await post('/api/generate-script', {
    content: 'https://example.com/some-article',
  });
  assert.strictEqual(status, 400);
  assert.strictEqual(json.success, false);
  assert.match(json.error, /链接/);
});

test('generate-script 缺少 API Key 属输入问题 400', async () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const { status, json } = await post('/api/generate-script', {
      content: '一段正常的正文内容，用于测试缺少 API Key 的错误分类。',
    });
    assert.strictEqual(status, 400);
    assert.match(json.error, /API Key/);
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('generate-script 死 baseURL 按上游错误 502', async () => {
  const { status, json } = await post('/api/generate-script', {
    content: '一段正常的正文内容，用于测试死端点场景的错误分类。',
    apiKey: 'test-key',
    baseURL: 'http://127.0.0.1:9',
    model: 'test-model',
  });
  assert.strictEqual(status, 502);
  assert.strictEqual(json.success, false);
});

test('synthesize-podcast 非文本行 400（非法行不再被静默丢弃）', async () => {
  const { status, json } = await post('/api/synthesize-podcast', {
    dialogue: [
      { speaker: '阿泽', text: '第一句正常台词' },
      { speaker: '小晓', text: { bad: 'object' } },
    ],
  });
  assert.strictEqual(status, 400);
  assert.match(json.error, /第 2 行/);
});

test('synthesize-podcast 缺 text 行 400', async () => {
  const { status } = await post('/api/synthesize-podcast', {
    dialogue: [{ speaker: '阿泽' }],
  });
  assert.strictEqual(status, 400);
});

test('synthesize-podcast 超过 300 行上限 400', async () => {
  const dialogue = Array.from({ length: 301 }, (_, i) => ({
    speaker: i % 2 ? '小晓' : '阿泽',
    text: `第 ${i + 1} 行`,
  }));
  const { status, json } = await post('/api/synthesize-podcast', { dialogue });
  assert.strictEqual(status, 400);
  assert.match(json.error, /行上限/);
});

test('one-click：模型输出超行数上限按上游错误 502', async () => {
  llmReply = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            podcastTitle: '测试标题',
            summary: '摘要',
            dialogue: Array.from({ length: 301 }, (_, i) => ({
              speaker: i % 2 ? '小晓' : '阿泽',
              text: '好',
            })),
          }),
        },
      },
    ],
    usage: {},
  };
  const { status, json } = await post('/api/one-click-generate', {
    rawText: '这是一段用于测试的正文内容，非空即可通过校验。',
    apiKey: 'test-key',
    baseURL: llmBase,
    model: 'test-model',
  });
  assert.strictEqual(status, 502);
  assert.match(json.error, /行上限/);
});

test('one-click：模型返回非 JSON 按上游错误 502', async () => {
  llmReply = { choices: [{ message: { content: '这不是 JSON' } }], usage: {} };
  const { status, json } = await post('/api/one-click-generate', {
    rawText: '这是一段用于测试的正文内容，非空即可通过校验。',
    apiKey: 'test-key',
    baseURL: llmBase,
    model: 'test-model',
  });
  assert.strictEqual(status, 502);
  assert.match(json.error, /剧本生成失败/);
});
