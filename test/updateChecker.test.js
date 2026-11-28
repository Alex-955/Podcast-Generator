'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createUpdateChecker } = require('../src/services/updateChecker');

const official = 'https://podcast.ai955.xyz/latest.json';
const github = 'https://api.github.com/repos/Alex-955/Podcast-Generator/releases/latest';
const downloadPageUrl = 'https://podcast.ai955.xyz/#onboarding';
const releaseUrl = 'https://github.com/Alex-955/Podcast-Generator/releases/latest';
const currentVersion = '1.1.0';
const offline = {
  currentVersion, checked: false, hasUpdate: false, offline: true,
  message: '暂无法连接更新服务，请稍后重试', downloadPageUrl, releaseUrl, notes: [],
};

function check(fetcher, options) {
  return createUpdateChecker({ fetcher, currentVersion, now: () => 0, ...options }).checkForUpdates();
}

test('官网更新仅发送固定 GET，清理文本、凭据和多余字段', async () => {
  const calls = [];
  const result = await check((url, options) => {
    calls.push([url, options]);
    return JSON.stringify({
      version: 'V1.10.0+build.01', releaseDate: '  <b>2026-11-28</b>\0 sk-private-key  ',
      releaseUrl: 'https://github.com/Alex-955/Podcast-Generator/releases/tag/v1.10.0',
      downloadPageUrl: 'https://podcast.ai955.xyz/download#mac',
      notes: [' ', '<b>第一项</b>\x01', false, 'Authorization: Bearer synthetic-token',
        '🌳'.repeat(121), '4\n5', '- 6', '7'], secret: 'private',
    });
  });
  assert.deepEqual(calls, [[official, { method: 'GET', headers: {}, timeoutMs: 5000, maxBytes: 65536 }]]);
  assert.deepEqual(result, {
    currentVersion, latestVersion: '1.10.0+build.01', hasUpdate: true, checked: true,
    offline: false, source: 'official', releaseDate: '2026-11-28 sk-***',
    notes: ['第一项', '***', '🌳'.repeat(120), '4', '5', '6'],
    releaseUrl: 'https://github.com/Alex-955/Podcast-Generator/releases/tag/v1.10.0',
    downloadPageUrl: 'https://podcast.ai955.xyz/download#mac', checkedAt: new Date(0).toISOString(),
  });
});

test('两个更新来源的日期、HTML 和 Markdown 文本脱敏本机路径，并保留公开链接', async () => {
  const date = '<i>2026-11-28</i> 来自/Users/someone/发布/release';
  const notes = ['<b>位置/Users/someone/secret/path</b>', String.raw`[位置C:\Users\someone\文档\path](https://example.invalid/guide)`,
    '说明 https://example.invalid/releases/v1.2.0 和 https://example.invalid/测试/v1.2.0/发布',
    '`/Users/someone/secret/path` 和 `C:\\Users\\someone\\path` 和 "/Users/my name/secret/file" 和 \'C:\\Program Files\\My App\\secret\' 和 保存在/用户/someone/secret',
    String.raw`file:///Users/someone/secret/path 和 file:///C:/Users/someone/path 和 ~/private/path 和 \\server\share\path`,
    'https://example.invalid/测试/release/notes?%2FUsers%2Fsomeone%2Fpath=1&file=%2FUsers%2Fsomeone%2Fpath&path=/Users/someone/path 和 https://example.invalid/%2FUsers%2Fsomeone%2Fsecret 和 https://example.invalid/C%3A%5CUsers%5Csecret 和 https://example.invalid/%5C%5Cserver%5Cshare%5Cpath'];
  for (const source of ['official', 'github']) {
    const result = await check(url => {
      if (source === 'official') return { version: '1.2.0', releaseDate: date, notes };
      if (url === official) return {};
      return { tag_name: 'v1.2.0', published_at: date, body: notes.join('\n') };
    });
    assert.equal(result.source, source);
    assert.equal(result.latestVersion, '1.2.0');
    assert.equal(result.releaseDate, '2026-11-28 来自***');
    assert.deepEqual(result.notes, ['位置***', '位置***', '说明 https://example.invalid/releases/v1.2.0 和 https://example.invalid/测试/v1.2.0/发布',
      '`***` 和 `***` 和 "***" 和 \'***\' 和 保存在***', '*** 和 *** 和 *** 和 ***',
      'https://example.invalid/测试/release/notes?***=1&file=***&path=*** 和 *** 和 *** 和 ***']);
  }
});

test('版本按核心数字、预发布标识符和稳定版排序，忽略构建标识', async () => {
  for (const [local, remote, hasUpdate] of [
    ['1.2.0', 'v1.10.0', true], ['2.0.0', '1.99.99', false],
    ['1.1.0', 'V1.1.1-alpha', true], ['1.1.0', '1.1.0-rc.1', false],
    ['1.1.0-rc.10', '1.1.0', true], ['1.1.0-rc.2', '1.1.0-rc.10', true],
    ['1.1.0-alpha', '1.1.0-alpha.1', true], ['1.1.0-alpha', '1.1.0-9', false],
    ['1.1.0-A', '1.1.0-a', true], ['1.1.0-rc+build', '1.1.0-rc', false],
    ['1.1.0', '1.1.0+001', false], ['9007199254740992.0.0', '9007199254740993.0.0', true],
  ]) {
    const result = await check(() => ({ version: remote }), { currentVersion: local });
    assert.equal(result.checked, true, remote);
    assert.equal(result.hasUpdate, hasUpdate, local + ' → ' + remote);
  }
});

test('非法版本与非清单 JSON 触发回退', async () => {
  for (const version of [' 1.1.0 ', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03',
    'vV1.2.3', '1.2.3-', '1.2.3+', '1.2.3-alpha..1', '1.2.3-a.01', '1.2.3+z.', '1.2.3-测试', '1.2.0-sk-secret123', 123]) {
    const result = await check(url => url === official ? { version } : { tag_name: 'v1.1.1' });
    assert.equal(result.source, 'github', String(version));
  }
  for (const body of ['null', '{}', '[]', '{invalid', '"1.1.1"', Buffer.alloc(65537, 32)]) {
    assert.equal((await check(url => url === official ? body : { tag_name: 'v1.1.0' })).source, 'github');
  }
});

test('GitHub 请求仅附版本和媒体类型，发布说明移除 Markdown 与敏感值', async () => {
  const calls = [];
  const result = await check((url, options) => {
    calls.push([url, options]);
    if (url === official) throw new Error('DNS failure');
    return { tag_name: 'v1.1.2', html_url: releaseUrl, published_at: ' 2026-11-28 ',
      body: '## 变更\r\n\r\n* [指南](https://example.invalid/guide)\n1. 修复 <b>问题</b>\n- Bearer abcdefg' };
  });
  assert.deepEqual(calls[1], [github, { method: 'GET', headers: {
    'User-Agent': 'InkCast/1.1.0', Accept: 'application/vnd.github+json',
  }, timeoutMs: 6000, maxBytes: 262144 }]);
  assert.deepEqual(result, {
    currentVersion, latestVersion: '1.1.2', checked: true, hasUpdate: true, offline: false, source: 'github',
    releaseDate: '2026-11-28', notes: ['变更', '指南', '修复 问题', 'Bearer ***'],
    releaseUrl, downloadPageUrl, checkedAt: new Date(0).toISOString(),
  });
});

test('两个来源均不可用、草稿和预发布标记均返回相同离线契约', async () => {
  for (const fallback of [null, 'broken', { tag_name: 'v2.0.0', draft: true },
    { tag_name: 'v2.0.0', prerelease: true }, { tag_name: '1.2' }, Buffer.alloc(262145)]) {
    assert.deepEqual(await check(url => url === official ? null : fallback), offline);
  }
  assert.deepEqual(await check(() => { throw new Error('private upstream detail'); }), offline);
});

test('所有外部跳转均受协议、来源和仓库路径限制', async () => {
  for (const url of ['http://podcast.ai955.xyz/path', 'https://podcast.ai955.xyz.invalid/', 'data:text/html,x',
    'https://u@podcast.ai955.xyz/', 'https://u:p@github.com/Alex-955/Podcast-Generator/',
    'https://github.com/Alex-955/Podcast-Generator-else', 'https://github.com/Alex-955/Podcast-Generator/../../else',
    'https://podcast.ai955.xyz:8443/', 'blob:https://podcast.ai955.xyz/x', '//podcast.ai955.xyz/', 'invalid', 42]) {
    const result = await check(() => ({ version: '1.1.0', downloadPageUrl: url, releaseUrl: url }));
    assert.equal(result.downloadPageUrl, downloadPageUrl, String(url));
    assert.equal(result.releaseUrl, releaseUrl, String(url));
  }
  const repo = 'https://github.com/Alex-955/Podcast-Generator';
  const result = await check(() => ({ version: '1.1.0', downloadPageUrl: repo, releaseUrl: repo + '/tags' }));
  assert.equal(result.downloadPageUrl, repo);
  assert.equal(result.releaseUrl, repo + '/tags');
});

test('官网和 GitHub 的跳转链接遇到查询参数、编码路径或敏感片段时回退', async () => {
  for (const suffix of ['?token=secret', '?apiKey=sk-123', '?lang=zh', '#sk-secret', '#/Users/someone/path',
    '/%2FUsers%2Fsomeone%2Fsecret', '/sk%2Dsecret123', '#%2FUsers%2Fsomeone%2Fpath', '#sk%2Dsecret123']) {
    const download = 'https://podcast.ai955.xyz/download' + suffix;
    const release = 'https://github.com/Alex-955/Podcast-Generator/releases/tag/v1.2.0' + suffix;
    const manifest = await check(() => ({ version: '1.2.0', downloadPageUrl: download, releaseUrl: release }));
    assert.equal(manifest.source, 'official');
    assert.equal(manifest.downloadPageUrl, downloadPageUrl, suffix);
    assert.equal(manifest.releaseUrl, releaseUrl, suffix);
    const backup = await check(url => url === official ? {} : { tag_name: 'v1.2.0', html_url: release });
    assert.equal(backup.source, 'github');
    assert.equal(backup.releaseUrl, releaseUrl, suffix);
  }
});

test('成功缓存六小时，强制检查间隔十秒，均从获取完成时起算', async () => {
  let time = 0, requests = 0;
  const { checkForUpdates } = createUpdateChecker({ now: () => time,
    fetcher: () => ({ version: '2.0.' + ++requests }) });
  const first = await checkForUpdates();
  time = 9999;
  assert.deepEqual(await checkForUpdates({ force: true }), first);
  time++;
  const second = await checkForUpdates({ force: true });
  assert.equal(second.latestVersion, '2.0.2');
  time += 6 * 3600000 - 1;
  assert.deepEqual(await checkForUpdates(), second);
  time++;
  assert.equal((await checkForUpdates()).latestVersion, '2.0.3');
  assert.equal(requests, 3);
});

test('离线后普通查询立即重试，手动失败节流，保留仍有效的成功缓存', async () => {
  let time = 0, reachable = false, requests = 0;
  const { checkForUpdates } = createUpdateChecker({ now: () => time, forceThrottleMs: 3, cacheTtlMs: 10,
    fetcher() { requests++; if (reachable) return { version: '2.0.0' }; throw new Error(); } });
  assert.deepEqual(await checkForUpdates(), offline);
  assert.deepEqual(await checkForUpdates({ force: true }), offline);
  assert.equal(requests, 2);
  reachable = true;
  const success = await checkForUpdates();
  assert.equal(success.checked, true);
  reachable = false;
  time = 3;
  assert.deepEqual(await checkForUpdates({ force: true }), offline);
  assert.deepEqual(await checkForUpdates(), success);
  time = 10;
  assert.deepEqual(await checkForUpdates(), offline);
  assert.equal(requests, 7);
});

test('并发查询合用正在进行的请求，耗时不抵扣缓存', async () => {
  let complete, calls = 0, time = 0;
  const { checkForUpdates } = createUpdateChecker({ now: () => time, cacheTtlMs: 50, fetcher() {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  } });
  const pending = [checkForUpdates(), checkForUpdates({ force: true })];
  time = 1000;
  complete({ version: '2.0.0' });
  const [a, b] = await Promise.all(pending);
  assert.deepEqual(a, b);
  time += 49;
  assert.deepEqual(await checkForUpdates(), a);
  assert.equal(calls, 1);
});

function mockHttps(t, getResponse) {
  return t.mock.method(https, 'get', (url, options, cb) => {
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    const request = new EventEmitter();
    const response = getResponse(url, options.signal);
    if (response) queueMicrotask(() => cb(response));
    else options.signal.addEventListener('abort', () => request.emit('error', new Error('timeout')), { once: true });
    return request;
  });
}

function httpResponse(parts, statusCode = 200, headers = {}) {
  return Object.assign(Readable.from(parts), { statusCode, headers });
}

test('HTTPS 拒绝重定向、HTTP 错误、超限声明和超限分块，随后尝试备用来源', async t => {
  for (const response of [
    httpResponse([], 302, { location: 'https://example.invalid/' }), httpResponse([], 503),
    httpResponse([Buffer.from('{"version":"1.2.0"}')], 200, { 'content-length': '65537' }),
    httpResponse([Buffer.from('{"version":"1.2.0"}'), Buffer.alloc(65536, 32)]),
  ]) {
    const mock = mockHttps(t, url => url === official ? response : httpResponse([Buffer.from('{"tag_name":"v2.0.0"}')]));
    assert.equal((await createUpdateChecker().checkForUpdates()).source, 'github');
    assert.deepEqual(mock.mock.calls.map(call => call.arguments[0]), [official, github]);
    assert.ok(response.destroyed);
    mock.mock.restore();
  }
});

test('HTTPS 在字节上限可读取 JSON，超过 GitHub 上限离线处理', async t => {
  for (const [limit, source] of [[65536, 'official'], [262144, 'github'], [262145, undefined]]) {
    const mock = mockHttps(t, url => {
      if (url === official && source !== 'official') return httpResponse([], 500);
      const json = url === official ? '{"version":"1.2.0"}' : '{"tag_name":"1.2.0"}';
      return httpResponse([Buffer.from(json.padEnd(limit))]);
    });
    const result = await createUpdateChecker().checkForUpdates();
    assert.equal(result.source, source);
    assert.equal(result.offline, !source);
    mock.mock.restore();
  }
});

test('HTTPS 的总时限会中止请求，双源超时返回离线状态', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  mockHttps(t, (url, signal) => { signals.push(signal); });
  const result = createUpdateChecker().checkForUpdates();
  t.mock.timers.tick(4999);
  assert.equal(signals[0].aborted, false);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals[0].aborted, true);
  t.mock.timers.tick(5999);
  assert.equal(signals[1].aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await result, offline);
  assert.equal(signals[1].aborted, true);
});
