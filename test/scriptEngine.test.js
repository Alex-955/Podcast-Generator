'use strict';
/**
 * B0-3：LLM 剧本归一化。复现缺陷：text 为对象时曾产生 `[object Object]` 污染；
 * speaker 别名与奇偶数兜底保证严格双人交替。
 */
const test = require('node:test');
const assert = require('node:assert');
const { getEventListeners } = require('node:events');
const axios = require('axios');
const { generatePodcastScript, normalizeDialogue } = require('../src/services/scriptEngine');

const SCRIPT_INPUT = { content: '离线测试正文', apiKey: 'test-key' };

function waitForAbort(_url, _body, { signal }) {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('transport cancelled')), { once: true });
  });
}

test('B0-3：非字符串 text 整行丢弃，绝不产生 [object Object]', () => {
  const dialogue = normalizeDialogue([
    { speaker: '阿泽', text: '正常台词' },
    { speaker: '阿泽', text: { evil: 'object' } }, // 曾产生 [object Object]
    null,
    '不是对象',
    { speaker: '小晓', text: '   ' }, // 空白
    { speaker: '小晓', text: 12345 }, // 数字
    { speaker: '小晓', text: '第二句正常台词' },
  ]);
  assert.deepStrictEqual(dialogue, [
    { speaker: '阿泽', text: '正常台词' },
    { speaker: '小晓', text: '第二句正常台词' },
  ]);
  assert.ok(!JSON.stringify(dialogue).includes('[object Object]'));
});

test('speaker 别名归一到阿泽/小晓', () => {
  const dialogue = normalizeDialogue([
    { speaker: '主持人阿泽', text: '一' },
    { speaker: '嘉宾小晓', text: '二' },
    { speaker: 'Host', text: '三' },
    { speaker: 'guest', text: '四' },
  ]);
  assert.deepStrictEqual(
    dialogue.map((d) => d.speaker),
    ['阿泽', '小晓', '阿泽', '小晓']
  );
});

test('未知 speaker 按奇偶位置归位，已知角色保留不强制交替', () => {
  const dialogue = normalizeDialogue([
    { speaker: '???', text: '一' },
    { speaker: '', text: '二' },
    { speaker: '神秘人', text: '三' },
  ]);
  assert.deepStrictEqual(
    dialogue.map((d) => d.speaker),
    ['阿泽', '小晓', '阿泽']
  );
});

test('已知角色连续同说话人保留，不强制交替', () => {
  const dialogue = normalizeDialogue([
    { speaker: '阿泽', text: '一' },
    { speaker: '阿泽', text: '二' },
    { speaker: '小晓', text: '三' },
  ]);
  assert.deepStrictEqual(
    dialogue.map((d) => d.speaker),
    ['阿泽', '阿泽', '小晓']
  );
});

test('emotion 仅在为非空字符串时保留', () => {
  const dialogue = normalizeDialogue([
    { speaker: '阿泽', text: '一', emotion: ' 开心 ' },
    { speaker: '小晓', text: '二', emotion: { bad: 'object' } },
    { speaker: '阿泽', text: '三', emotion: '   ' },
  ]);
  assert.strictEqual(dialogue[0].emotion, '开心');
  assert.ok(!('emotion' in dialogue[1]));
  assert.ok(!('emotion' in dialogue[2]));
});

test('全部无效时报错而不是返回空剧本', () => {
  assert.throws(() => normalizeDialogue([{ speaker: '阿泽', text: {} }]), /没有有效台词/);
  assert.throws(() => normalizeDialogue('不是数组'), /dialogue/);
});

test('预先取消时，剧本生成抛 AbortError 且不发请求', async (t) => {
  const post = t.mock.method(axios, 'post', () => assert.fail('已取消，不应发起请求'));
  const signal = AbortSignal.abort('cancel');
  await assert.rejects(generatePodcastScript({ ...SCRIPT_INPUT, signal }), { name: 'AbortError' });
  assert.strictEqual(post.mock.callCount(), 0);
});

test('剧本生成中途取消会中止底层请求并抛 AbortError', async (t) => {
  const post = t.mock.method(axios, 'post', waitForAbort);
  const controller = new AbortController();
  const { signal } = controller;
  const result = generatePodcastScript({ ...SCRIPT_INPUT, signal });
  const requestSignal = post.mock.calls[0].arguments[2].signal;

  assert.notStrictEqual(requestSignal, signal);
  assert.strictEqual(getEventListeners(signal, 'abort').length, 1);
  controller.abort(new Error('自定义取消原因'));
  assert.strictEqual(requestSignal.aborted, true);
  await assert.rejects(result, (error) => error.name === 'AbortError' && error.statusCode === undefined);
  assert.strictEqual(getEventListeners(signal, 'abort').length, 0);
});

test('剧本生成超时仍报 502 并清理外部取消监听', async (t) => {
  t.mock.method(axios, 'post', waitForAbort);
  const { signal } = new AbortController();
  await assert.rejects(generatePodcastScript({ ...SCRIPT_INPUT, signal, timeoutMs: 25 }), {
    name: 'UpstreamError',
    statusCode: 502,
    message: /剧本生成超时/,
  });
  assert.strictEqual(signal.aborted, false);
  assert.strictEqual(getEventListeners(signal, 'abort').length, 0);
});
