'use strict';
/**
 * B0-2：抓取与正文选优回归（全离线，fetcher 注入）。
 * 复现缺陷：
 * 1. 短正文候选挡住更长的有效正文（应继续选优而不是首非空优先）；
 * 2. 标题与正文来自不同候选导致错配（应同源配对）。
 * 另覆盖：微信错误页识别、确定性截断、SSRF 目标校验、粘贴正文旁路。
 */
const test = require('node:test');
const assert = require('node:assert');
const { getEventListeners } = require('node:events');
const {
  extractArticle,
  extractArticleFromUrl,
  assertValidUrl,
  assertSafeFetchTarget,
  defaultFetcher,
  MAX_CONTENT_LENGTH,
} = require('../src/services/extractor');

const TEST_URL = 'https://article.example.com/post/1';
const LONG_PARA = '这是一段足够长的正文内容，用于通过最短正文长度校验，同时模拟真实文章段落的连续文字。';

function page({ title, body }) {
  const meta = title ? `<meta property="og:title" content="${title}">` : '';
  return `<!doctype html><html><head>${meta}</head><body>${body}</body></html>`;
}

// 一次性 fetcher：按调用次数依次返回预设页面
function fetcherSequence(pages) {
  let call = 0;
  return async () => ({ data: pages[Math.min(call++, pages.length - 1)] });
}

test('B0-2 选优：短正文候选不挡住更长的有效正文', async () => {
  // article 只有 120 字短文本（旧逻辑会被它挡住），.article-content 才是 480+ 字有效正文
  const shortJunk = '短'.repeat(120);
  const html = page({
    title: '正确标题',
    body: `
      <article>${shortJunk}</article>
      <div class="article-content"><p>LONG_MARKER ${LONG_PARA.repeat(8)}</p></div>
    `,
  });
  const result = await extractArticleFromUrl(TEST_URL, { fetcher: fetcherSequence([html]) });
  assert.ok(result.content.length > 200, `正文过短：${result.content.length}`);
  assert.ok(result.content.includes('LONG_MARKER'), '应选中长正文而不是短候选');
  assert.ok(!result.content.includes('短'.repeat(50)), '不应选中短候选');
  assert.strictEqual(result.title, '正确标题');
});

test('B0-2 同源：标题与正文来自同一次抓取（重试换 UA 后不混用旧标题）', async () => {
  // 第一次抓取（移动 UA）：正文不足 200 字，但标题存在——旧逻辑会把这里的标题配上第二次的正文
  const first = page({
    title: '标题A',
    body: `<article><p>${'A 方案的短内容。'.repeat(3)}</p></article>`,
  });
  // 第二次抓取（桌面 UA）：有效正文 + 自己的标题
  const second = page({
    title: '标题B',
    body: `<article><p>B_MARKER ${LONG_PARA.repeat(8)}</p></article>`,
  });

  const result = await extractArticleFromUrl(TEST_URL, { fetcher: fetcherSequence([first, second]) });
  assert.strictEqual(result.title, '标题B', '标题必须与正文同源');
  assert.ok(result.content.includes('B_MARKER'));
});

test('标题兜底：正文容器内标题 → og:title 之外的 h1；完全无标题 → 未命名文章', async () => {
  const withH1 = page({ title: null, body: `<article><h1>正文标题</h1><p>${LONG_PARA.repeat(8)}</p></article>` });
  const r1 = await extractArticleFromUrl(TEST_URL, { fetcher: fetcherSequence([withH1]) });
  assert.strictEqual(r1.title, '正文标题');

  const noTitle = page({ title: null, body: `<article><p>${LONG_PARA.repeat(8)}</p></article>` });
  const r2 = await extractArticleFromUrl(TEST_URL, { fetcher: fetcherSequence([noTitle]) });
  assert.strictEqual(r2.title, '未命名文章');
});

test('微信错误页：识别并报 502 上游错误', async () => {
  const html = page({ title: '', body: '<div>该内容已被发布者删除</div>' });
  await assert.rejects(
    () => extractArticleFromUrl('https://mp.weixin.qq.com/s/TEST123', { fetcher: fetcherSequence([html]) }),
    (e) => e.statusCode === 502 && /已被发布者删除/.test(e.message)
  );
});

test('两轮都抓不到足够正文时明确报错并提示粘贴正文', async () => {
  const short = page({ title: '标题', body: '<article><p>只有短短一句话。</p></article>' });
  await assert.rejects(
    () => extractArticleFromUrl(TEST_URL, { fetcher: fetcherSequence([short, short]) }),
    (e) => e.statusCode === 502 && /直接把文章正文粘贴/.test(e.message)
  );
});

test('超长正文确定性截断并置 truncated', async () => {
  const huge = page({
    title: '长文',
    body: `<article><p>${LONG_PARA.repeat(400)}</p></article>`, // 1 万字以上
  });
  const result = await extractArticleFromUrl(TEST_URL, { fetcher: fetcherSequence([huge]) });
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.content.length, MAX_CONTENT_LENGTH);
});

test('截断语义贯通 rawText 旁路', async () => {
  const r1 = await extractArticle({ rawText: '  文章正文  ' });
  assert.strictEqual(r1.title, '');
  assert.strictEqual(r1.content, '文章正文');
  assert.strictEqual(r1.truncated, false);

  const r2 = await extractArticle({ rawText: '字'.repeat(MAX_CONTENT_LENGTH + 100) });
  assert.strictEqual(r2.truncated, true);
  assert.strictEqual(r2.content.length, MAX_CONTENT_LENGTH);
});

test('URL 校验：拒绝非 http(s) 与把正文粘进链接框的误用', () => {
  assert.throws(() => assertValidUrl('javascript:alert(1)'), (e) => e.statusCode === 400);
  assert.throws(() => assertValidUrl('ftp://example.com/a'), (e) => e.statusCode === 400);
  assert.throws(() => assertValidUrl('这是一大段正文，不是链接'), (e) => e.statusCode === 400);
  assert.strictEqual(assertValidUrl(TEST_URL), TEST_URL);
});

test('SSRF 防护：默认拒绝内网/回环目标，ALLOW_PRIVATE_FETCH=1 显式放开', () => {
  assert.throws(() => assertSafeFetchTarget('http://127.0.0.1/x'));
  assert.throws(() => assertSafeFetchTarget('http://10.0.0.5/x'));
  assert.throws(() => assertSafeFetchTarget('http://192.168.1.1/x'));
  assert.throws(() => assertSafeFetchTarget('http://172.16.0.1/x'));
  assert.throws(() => assertSafeFetchTarget('http://169.254.169.254/latest/meta-data/'));
  assert.throws(() => assertSafeFetchTarget('http://[::1]/x'));
  assert.throws(() => assertSafeFetchTarget('http://localhost/x'));
  assert.throws(() => assertSafeFetchTarget('http://intranet.local/x'));
  assert.doesNotThrow(() => assertSafeFetchTarget('https://8.8.8.8/x'));
  assert.doesNotThrow(() => assertSafeFetchTarget(TEST_URL));

  process.env.ALLOW_PRIVATE_FETCH = '1';
  try {
    assert.doesNotThrow(() => assertSafeFetchTarget('http://127.0.0.1/x'));
  } finally {
    delete process.env.ALLOW_PRIVATE_FETCH;
  }
});

test('B-F3：IPv4-mapped IPv6（点分与十六进制形态）规范化后按 IPv4 规则拒绝', () => {
  // 修复前绕过路径：URL 会把 ::ffff:127.0.0.1 序列化为 ::ffff:7f00:1，旧点分前缀检查全部失效
  assert.throws(() => assertSafeFetchTarget('http://[::ffff:127.0.0.1]/'), (e) => e.statusCode === 400);
  assert.throws(() => assertSafeFetchTarget('http://[::ffff:7f00:1]/'), (e) => e.statusCode === 400);
  assert.throws(() => assertSafeFetchTarget('http://[::ffff:a00:1]/'), (e) => e.statusCode === 400); // 10.0.0.1
  assert.throws(() => assertSafeFetchTarget('http://[::ffff:c0a8:101]/'), (e) => e.statusCode === 400); // 192.168.1.1
  assert.throws(() => assertSafeFetchTarget('http://[::ffff:a9fe:a9fe]/'), (e) => e.statusCode === 400); // 169.254.169.254
  assert.throws(() => assertSafeFetchTarget('http://[fd00::1]/x'), (e) => e.statusCode === 400);
  assert.throws(() => assertSafeFetchTarget('http://[fe80::1]/x'), (e) => e.statusCode === 400);
  assert.doesNotThrow(() => assertSafeFetchTarget('http://[::ffff:8.8.8.8]/x'));
  assert.doesNotThrow(() => assertSafeFetchTarget('http://[2001:db8::1]/x'));
});

test('B-F3：defaultFetcher 逐跳校验重定向目标，拒绝跳向内网（假传输，零网络访问）', async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.endsWith('/hop1')) return { status: 302, headers: { location: '/hop2' }, data: '' };
    if (url.endsWith('/hop2')) {
      return { status: 302, headers: { location: 'http://[::ffff:169.254.169.254]/latest/meta-data/' }, data: '' };
    }
    return { status: 200, headers: {}, data: '<html>ok</html>' };
  };
  await assert.rejects(
    defaultFetcher('https://article.example.com/hop1', {}, { request }),
    (e) => e.statusCode === 400 && /内网/.test(e.message)
  );
  // 被拒的内网目标绝不能真的发出请求
  assert.strictEqual(calls.length, 2);
  assert.ok(calls.every((u) => !u.includes('169.254')));
});

test('B-F3：defaultFetcher 限制重定向跳数（最多跟随 5 次）', async () => {
  const request = async () => ({ status: 302, headers: { location: '/loop' }, data: '' });
  await assert.rejects(
    defaultFetcher('https://article.example.com/loop', {}, { request }),
    (e) => /重定向次数过多/.test(e.message)
  );
});

test('B-F3：defaultFetcher 正常跟随同域重定向', async () => {
  const request = async (url) => {
    if (url.endsWith('/a')) return { status: 301, headers: { location: '/b' }, data: '' };
    return { status: 200, headers: {}, data: '<html>正文</html>' };
  };
  const r = await defaultFetcher('https://article.example.com/a', {}, { request });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data, '<html>正文</html>');
});

test('预先取消时，抓取器与文章入口均直接抛 AbortError', async () => {
  const signal = AbortSignal.abort(new Error('自定义取消原因'));
  const unreachable = () => assert.fail('已取消，不应发起请求');

  await assert.rejects(defaultFetcher(TEST_URL, {}, { signal, request: unreachable }), { name: 'AbortError' });
  await assert.rejects(extractArticleFromUrl(TEST_URL, { signal, fetcher: unreachable }), { name: 'AbortError' });
  await assert.rejects(extractArticle({ rawText: '文章正文' }, { signal }), { name: 'AbortError' });
});

test('抓取中途取消会中止底层请求，不换 UA 重试，也不报 502', async () => {
  const controller = new AbortController();
  const { signal } = controller;
  let calls = 0;
  let requestSignal;
  const fetcher = (url, headers, options) => defaultFetcher(url, headers, {
    ...options,
    request(_url, config) {
      calls += 1;
      requestSignal = config.signal;
      return new Promise((_, reject) => {
        requestSignal.addEventListener('abort', () => reject(new Error('transport cancelled')), { once: true });
      });
    },
  });

  const result = extractArticle({ url: TEST_URL }, { signal, fetcher });
  assert.notStrictEqual(requestSignal, signal);
  assert.strictEqual(getEventListeners(signal, 'abort').length, 1);
  controller.abort('cancel');
  assert.strictEqual(requestSignal.aborted, true);
  await assert.rejects(result, (error) => error.name === 'AbortError' && error.statusCode === undefined);
  assert.strictEqual(calls, 1);
  assert.strictEqual(getEventListeners(signal, 'abort').length, 0);
});

test('抓取完成后移除外部取消监听', async () => {
  const controller = new AbortController();
  let requestSignal;
  await defaultFetcher(TEST_URL, {}, {
    signal: controller.signal,
    request: async (_url, config) => {
      requestSignal = config.signal;
      return { status: 200 };
    },
  });
  assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  assert.strictEqual(requestSignal.aborted, false);
});

test('ALLOW_INSECURE_TLS 每次发请求时读取，仅值为 1 时使用宽松 TLS Agent', async () => {
  const original = process.env.ALLOW_INSECURE_TLS;
  const agents = [];
  const request = async (_url, config) => {
    agents.push(config.httpsAgent);
    if (agents.length === 1) {
      process.env.ALLOW_INSECURE_TLS = '1';
      return { status: 302, headers: { location: '/next' } };
    }
    return { status: 200 };
  };

  try {
    delete process.env.ALLOW_INSECURE_TLS;
    await defaultFetcher(TEST_URL, {}, { request });
    await defaultFetcher(TEST_URL, {}, { request });
    process.env.ALLOW_INSECURE_TLS = '0';
    await defaultFetcher(TEST_URL, {}, { request });

    assert.strictEqual(agents[0], undefined);
    assert.strictEqual(agents[1].options.rejectUnauthorized, false);
    assert.strictEqual(agents[2].options.rejectUnauthorized, false);
    assert.notStrictEqual(agents[1], agents[2]);
    assert.strictEqual(agents[3], undefined);
  } finally {
    if (original === undefined) delete process.env.ALLOW_INSECURE_TLS;
    else process.env.ALLOW_INSECURE_TLS = original;
  }
});
