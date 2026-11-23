'use strict';
const test = require('node:test');
const assert = require('node:assert');
const InputSource = require('../public/inputSource');

test('createState 默认 URL 模式且未在忙碌', () => {
  const state = InputSource.createState();
  assert.strictEqual(state.mode, 'url');
  assert.strictEqual(state.busy, false);
  assert.strictEqual(state.opSeq, 0);
  assert.strictEqual(state.activeSentenceIndex, -1);
});

test('setMode 拒绝未知模式', () => {
  const state = InputSource.createState();
  assert.strictEqual(InputSource.setMode(state, 'text'), 'text');
  assert.strictEqual(state.mode, 'text');
  assert.throws(() => InputSource.setMode(state, 'both'), /未知输入模式/);
});

test('beginOperation/finishOperation：操作互斥，防止重复点击', () => {
  const state = InputSource.createState();
  const seq1 = InputSource.beginOperation(state, 'https://a.example.com');
  assert.strictEqual(seq1, 1);
  assert.strictEqual(state.busy, true);

  // 忙碌期间再次点击返回 null
  assert.strictEqual(InputSource.beginOperation(state, 'https://b.example.com'), null);

  // 过期 seq 不能误释放新操作的锁
  InputSource.finishOperation(state, 999);
  assert.strictEqual(state.busy, true);

  InputSource.finishOperation(state, seq1);
  assert.strictEqual(state.busy, false);
  const seq2 = InputSource.beginOperation(state);
  assert.strictEqual(seq2, 2);
});

test('applyParseResult：正常应用', () => {
  const state = InputSource.createState();
  const seq = InputSource.beginOperation(state, 'https://a.example.com/p');
  const result = InputSource.applyParseResult(state, {
    seq,
    url: 'https://a.example.com/p',
    currentUrl: 'https://a.example.com/p',
    title: '标题',
    content: '正文',
  });
  assert.strictEqual(result, 'applied');
  assert.strictEqual(state.parsedUrl, 'https://a.example.com/p');
  assert.strictEqual(state.parsedTitle, '标题');
  assert.strictEqual(state.parsedContent, '正文');
});

test('applyParseResult：慢请求晚到（seq 过期）被丢弃', () => {
  const state = InputSource.createState();
  const seq1 = InputSource.beginOperation(state, 'https://a.example.com');
  InputSource.finishOperation(state, seq1);
  const seq2 = InputSource.beginOperation(state, 'https://b.example.com');

  const result = InputSource.applyParseResult(state, {
    seq: seq1,
    url: 'https://a.example.com',
    currentUrl: 'https://a.example.com',
    title: '旧标题',
    content: '旧正文',
  });
  assert.strictEqual(result, 'stale-seq');
  assert.strictEqual(state.parsedContent, ''); // 过期结果不覆盖
  assert.strictEqual(state.opSeq, seq2);
});

test('applyParseResult：URL 已被用户改掉则丢弃（解析 A 改成 B 必须用 B）', () => {
  const state = InputSource.createState();
  const seq = InputSource.beginOperation(state, 'https://a.example.com');
  const result = InputSource.applyParseResult(state, {
    seq,
    url: 'https://a.example.com',
    currentUrl: 'https://b.example.com', // 用户已改输入
    title: 'A 的标题',
    content: 'A 的正文',
  });
  assert.strictEqual(result, 'stale-url');
  assert.strictEqual(state.parsedContent, '');
});

test('applyParseResult：已切文本模式则丢弃', () => {
  const state = InputSource.createState();
  const seq = InputSource.beginOperation(state, 'https://a.example.com');
  InputSource.setMode(state, 'text');
  const result = InputSource.applyParseResult(state, {
    seq,
    url: 'https://a.example.com',
    currentUrl: 'https://a.example.com',
    title: '标题',
    content: '正文',
  });
  assert.strictEqual(result, 'wrong-mode');
  assert.strictEqual(state.parsedContent, '');
});

test('selectGenerationInput：URL 模式只用当前 URL，不混用正文', () => {
  const state = InputSource.createState(); // 默认 url 模式
  const input = InputSource.selectGenerationInput(state, {
    urlInput: ' https://a.example.com/p ',
    textTitle: '解析得到的标题',
    textContent: '解析得到的正文',
  });
  assert.deepStrictEqual(input, { kind: 'url', url: 'https://a.example.com/p' });
});

test('selectGenerationInput：文本模式只用当前正文，不混用 URL', () => {
  const state = InputSource.createState();
  InputSource.setMode(state, 'text');
  const input = InputSource.selectGenerationInput(state, {
    urlInput: 'https://a.example.com/p',
    textTitle: ' 手动标题 ',
    textContent: ' 手动正文 ',
  });
  assert.deepStrictEqual(input, { kind: 'text', title: '手动标题', content: '手动正文' });
});

test('resetPlaybackHighlight 重置逐句高亮', () => {
  const state = InputSource.createState({ activeSentenceIndex: 7 });
  InputSource.resetPlaybackHighlight(state);
  assert.strictEqual(state.activeSentenceIndex, -1);
});
