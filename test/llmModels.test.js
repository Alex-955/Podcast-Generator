const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fetchLlmModels } = require('../src/services/llmModels');
const { isPublicModel, llmSecrets, normalizeBaseURL } = require('../src/services/llmCredentials');
const { upstreamError } = require('../src/services/providerHttp');
const { assertCancellationCleanup, configureLlm, response } = require('./helpers/llmFixture');

const apiKey = 'models-offline-token';
const baseURL = 'https://models-fixture.example/gateway/v1/';
const payload = { apiKey, baseURL };

test('模型列表规范化地址、保留顺序并去重，过滤不安全及敏感 ID', async t => {
  configureLlm(t, { VISION_API_KEY: 'server-vision-secret' });
  const stream = response({ data: [
    null, { id: 'vendor/model-1', owned_by: ' vendor ' }, 'vendor/model-1', 'plain-model',
    { id: 'vendor/model-2:fast', owned_by: apiKey + ' ' + baseURL + ' /Users/private/model-owner' },
    'a b', '/Users/local/model', 'foo//bar', baseURL, 'sk-sensitive-shape', 'prefix-' + apiKey, 'server-vision-secret',
    { id: 42 }, { id: '' }, 'C:/Users/private', 'c:\\Users\\private', '.', '..', 'a/./b', 'a/../b', ' model ',
    'a'.repeat(161), 'caller-vision-secret',
  ], models: ['ignored'] });
  const llmRequest = t.mock.fn(async (url, args) => {
    assert.equal(url, 'https://models-fixture.example/gateway/v1/models');
    assert.equal(args.method, 'GET');
    assert.deepEqual(args.headers, { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' });
    assert.equal(args.body, undefined);
    assert.equal(args.allowPrivateEndpoint, false);
    assert.ok(args.signal instanceof AbortSignal);
    return stream;
  });
  const { latencyMs, ...data } = await fetchLlmModels({ ...payload, visionApiKey: 'caller-vision-secret' }, { llmRequest });
  assert.ok(latencyMs >= 0);
  assert.deepEqual(data, { supported: true, count: 3, models: [
    { id: 'vendor/model-1', ownedBy: 'vendor' },
    { id: 'plain-model', ownedBy: '' },
    { id: 'vendor/model-2:fast', ownedBy: '*** *** ***' },
  ] });
  assert.equal(llmRequest.mock.callCount(), 1);
  assert.equal(stream.destroyed, true);
});

test('模型列表接受 models 字段，并在去重和过滤后返回最多 500 项', async t => {
  configureLlm(t);
  const models = Array.from({ length: 502 }, (_, i) => 'model-' + i);
  const result = await fetchLlmModels({ ...payload, scope: 'llm' }, {
    llmRequest: async () => response({ data: {}, models: ['/invalid', models[0], ...models] }),
  });
  assert.equal(result.supported, true);
  assert.equal(result.count, 500);
  assert.deepEqual(result.models.map(item => item.id), models.slice(0, 500));
});

test('普通和识图模型列表按同一绑定规则解析，不要求先选择模型', async t => {
  const visionBase = 'http://127.0.0.1:2222/vision';
  const llmBase = 'http://127.0.0.1:3333/gateway';
  configureLlm(t, {
    VISION_API_KEY: 'server-vision-token', VISION_BASE_URL: visionBase + '/v1/', VISION_MODEL: 'invalid model',
    DEEPSEEK_API_KEY: 'server-llm-token', LLM_BASE_URL: llmBase + '/', LLM_MODEL: 'invalid model',
  });
  const calls = [];
  const llmRequest = async (url, args) => {
    calls.push([url, args.headers.Authorization, args.allowPrivateEndpoint]);
    return response({ data: ['test'] });
  };
  for (const [input, base, key, allowPrivate] of [
    [{ scope: 'llm', baseURL: llmBase + '/v1' }, llmBase, 'server-llm-token', true],
    [{ scope: 'llm', apiKey, baseURL: visionBase }, visionBase, apiKey, true],
    [{ scope: 'vision' }, visionBase, 'server-vision-token', true],
    [{ scope: 'vision', visionBaseURL: llmBase + '/v1/' }, llmBase, 'server-llm-token', true],
    [{ scope: 'vision', visionApiKey: apiKey, visionBaseURL: visionBase }, visionBase, apiKey, true],
    [{ scope: 'vision', visionApiKey: apiKey, visionBaseURL: baseURL }, baseURL.slice(0, -4), apiKey, false],
    [{ ...payload, scope: 'vision' }, baseURL.slice(0, -4), apiKey, false],
  ]) {
    assert.equal((await fetchLlmModels(input, { llmRequest })).count, 1);
    assert.deepEqual(calls.pop(), [base + '/v1/models', 'Bearer ' + key, allowPrivate]);
  }
  await assert.rejects(fetchLlmModels({ scope: 'vision', apiKey, visionBaseURL: baseURL }, { llmRequest }),
    { statusCode: 400, message: /接口地址/ });
  await assert.rejects(fetchLlmModels({ scope: 'vision', visionApiKey: apiKey }, { llmRequest }),
    { statusCode: 400, message: /识图 Base URL/ });
  await assert.rejects(fetchLlmModels({ scope: 'vision', visionApiKey: apiKey, visionBaseURL: baseURL, visionModel: apiKey }, { llmRequest }),
    { statusCode: 400, message: /模型名称无效/ });
  assert.deepEqual(calls, []);

  delete process.env.VISION_API_KEY;
  delete process.env.VISION_BASE_URL;
  delete process.env.VISION_MODEL;
  await fetchLlmModels({ scope: 'vision' }, { llmRequest });
  assert.deepEqual(calls.pop(), [llmBase + '/v1/models', 'Bearer server-llm-token', true]);
  delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(fetchLlmModels({ scope: 'vision' }, { llmRequest }), { statusCode: 400, message: /API Key/ });
  assert.deepEqual(calls, []);
});

test('404/405 返回手填提示，鉴权失败和其他状态返回上游错误', async t => {
  configureLlm(t);
  for (const status of [404, 405, 401, 403, 429, 500]) {
    const stream = response({ error: apiKey + ' ' + baseURL }, status);
    const fetchModels = fetchLlmModels(payload, { llmRequest: async () => stream });
    if ([404, 405].includes(status)) {
      const { latencyMs, ...data } = await fetchModels;
      assert.ok(latencyMs >= 0);
      assert.deepEqual(data, { supported: false, models: [], count: 0,
        message: '该接口暂未开放自动拉取模型列表，请直接手动填写模型名称' });
    } else {
      const auth = [401, 403].includes(status);
      await assert.rejects(fetchModels, {
        statusCode: 502, retryable: !auth,
        message: auth
          ? `鉴权失败或该地址不支持通用接口访问（HTTP ${status}），请检查 API Key 或所选接口体系`
          : `HTTP ${status}`,
      });
    }
    assert.equal(stream.destroyed, true);
  }
});

test('模型列表拒绝无效范围、缺密钥、未授权地址及解析到私网的主机', async t => {
  configureLlm(t);
  const llmRequest = t.mock.fn();
  for (const scope of [null, '', 'other', 1]) {
    await assert.rejects(fetchLlmModels({ ...payload, scope }, { llmRequest }), { statusCode: 400, message: /范围/ });
  }
  await assert.rejects(fetchLlmModels({}, { llmRequest }), { statusCode: 400, message: '请先填写 API Key 再获取模型列表' });
  process.env.DEEPSEEK_API_KEY = 'server-llm-token';
  await assert.rejects(fetchLlmModels({ baseURL }, { llmRequest }), { statusCode: 400, message: /对应的 API Key/ });
  for (const invalid of ['file:///tmp/mock', 'https://user:pass@model.example', 'https://model.example?', 'https://model.example#']) {
    await assert.rejects(fetchLlmModels({ apiKey, baseURL: invalid }, { llmRequest }), { statusCode: 400, message: /地址无效/ });
  }
  for (const blocked of ['http://127.0.0.1', 'http://[::1]', 'http://models.internal']) {
    for (const scope of ['llm', 'vision']) {
      await assert.rejects(fetchLlmModels({ apiKey, baseURL: blocked, scope }, { llmRequest }),
        { statusCode: 400, message: /受限网络/ });
    }
  }
  assert.equal(llmRequest.mock.callCount(), 0);
  let lookups = 0;
  await assert.rejects(fetchLlmModels(payload, { lookup: async () => {
    lookups++;
    return [{ address: '127.0.0.1', family: 4 }];
  } }), { statusCode: 400, message: /受限网络/ });
  assert.equal(lookups, 1);
});

test('模型列表拒绝无效和超限响应，脱敏已分类错误并隐藏未知错误原文', async t => {
  configureLlm(t);
  for (const [stream, message] of [
    [response({ data: [], error: { message: apiKey } }), /响应格式无效/],
    [response({ data: 'invalid' }), /响应格式无效/],
    [response('{'), /有效 JSON/],
    [response('A'.repeat(2 * 1024 * 1024 + 1)), /大小限制/],
    [response('{}', 200, { 'content-length': 2 * 1024 * 1024 + 1 }), /大小限制/],
  ]) {
    await assert.rejects(fetchLlmModels(payload, { llmRequest: async () => stream }), { statusCode: 502, message });
    assert.equal(stream.destroyed, true);
  }
  const details = apiKey + ' ' + baseURL + ' /Users/private/models';
  await assert.rejects(fetchLlmModels(payload, { llmRequest: async () => { throw upstreamError('失败 ' + details, false); } }),
    { statusCode: 502, retryable: false, message: '失败 *** *** ***' });
  const tts = { apiKey: 'request-tts-fixture', endpoint: 'https://offline-tts.example/service' };
  const message = [tts.apiKey, tts.endpoint, 'path:C:/Users/private', 'path:/Users/private/a', 'https://docs.example/api', 'vendor/model:fast'].join(' ');
  await assert.rejects(fetchLlmModels({ ...payload, tts }, { llmRequest: async () => { throw upstreamError(message, false); } }),
    { statusCode: 502, retryable: false, message: '*** *** path:*** path:*** https://docs.example/api vendor/model:fast' });
  await assert.rejects(fetchLlmModels(payload, { llmRequest: async () => { throw new Error(details); } }),
    { statusCode: 502, message: '模型列表接口连接失败' });
});

test('模型列表成功、超时和取消时清理响应、定时器及监听', async t => {
  configureLlm(t);
  await assertCancellationCleanup(t, fetchLlmModels, payload, { data: ['model'] });
});

test('normalizeBaseURL 保留豆包 /api/v3 等版本段路径，缺少版本段时才补 /v1', () => {
  const cases = [
    ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['https://ark.cn-beijing.volces.com/api/v3/', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4'],
    ['https://open.bigmodel.cn/api/paas/v4/', 'https://open.bigmodel.cn/api/paas/v4'],
    ['https://qianfan.baidubce.com/v2', 'https://qianfan.baidubce.com/v2'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/v1'],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['https://proxy.example/team', 'https://proxy.example/team/v1'],
    ['https://proxy.example/my-v3', 'https://proxy.example/my-v3/v1'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeBaseURL(input), expected, input);
  }
});

test('llmSecrets 仅对 /v1 派生去后缀变体，过滤根工作目录同时保留短绝对路径', t => {
  configureLlm(t, { DATA_DIR: '/', PODCASTS_DIR: 'C:\\' });
  t.mock.method(process, 'cwd', () => '/');
  const arkBase = 'https://ark.cn-beijing.volces.com/api/v3';
  const secrets = llmSecrets({ baseURL: arkBase + '/' }, { apiKey: 'ark-secret', baseURL: arkBase + '/' });
  assert.ok(secrets.includes('ark-secret'));
  assert.ok(secrets.includes(arkBase));
  assert.ok(!secrets.includes('https://ark.cn-beijing.volces.com/api'));
  assert.ok(!secrets.includes('/'));
  assert.ok(!secrets.includes('C:\\'));
  assert.equal(isPublicModel('doubao/seed-1.6', secrets), true);

  const v1Secrets = llmSecrets({ baseURL: 'https://proxy.example/gateway/v1/' }, { apiKey: 'v1-secret', baseURL: 'https://proxy.example/gateway/v1/' });
  assert.ok(v1Secrets.includes('https://proxy.example/gateway'));
  assert.ok(v1Secrets.includes('https://proxy.example/gateway/v1'));

  // 合法短绝对路径（如 /a、/.a）和真实工作目录必须保留在敏感列表中
  configureLlm(t, { DATA_DIR: '/a', PODCASTS_DIR: '/.a' });
  t.mock.method(process, 'cwd', () => '/Users/demo/workspace/app');
  const realPathSecrets = llmSecrets({ baseURL: arkBase }, { apiKey: 'ark-secret', baseURL: arkBase });
  assert.ok(realPathSecrets.includes('/a'));
  assert.ok(realPathSecrets.includes('/.a'));
  assert.ok(realPathSecrets.includes('/Users/demo/workspace/app'));
});

test('豆包火山方舟 /api/v3 拉取模型列表直连 /api/v3/models，404/405 与空列表均返回方舟专属手填提示', async t => {
  configureLlm(t);
  const arkBase = 'https://ark.cn-beijing.volces.com/api/v3';
  const requested = [];
  const listed = await fetchLlmModels({ apiKey: 'ark-key', baseURL: arkBase }, {
    llmRequest: async url => {
      requested.push(url);
      return response({ data: [{ id: 'doubao-seed-1-6-250615', owned_by: 'volcengine' }] });
    },
  });
  assert.deepEqual(requested, ['https://ark.cn-beijing.volces.com/api/v3/models']);
  assert.equal(listed.supported, true);
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.models, [{ id: 'doubao-seed-1-6-250615', ownedBy: 'volcengine' }]);
  assert.equal('message' in listed, false);

  for (const status of [404, 405]) {
    const unsupported = await fetchLlmModels({ apiKey: 'ark-key', baseURL: arkBase + '/' }, {
      llmRequest: async url => {
        assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/models');
        return response({ error: 'not found' }, status);
      },
    });
    assert.equal(unsupported.supported, false);
    assert.deepEqual(unsupported.models, []);
    assert.match(unsupported.message, /火山方舟/);
    assert.match(unsupported.message, /ep-xxx/);
  }

  // 服务端 .env 配置方舟且返回空列表时，主模型和识图均由后端返回方舟专属手填提示
  configureLlm(t, {
    DEEPSEEK_API_KEY: 'ark-server-key',
    LLM_BASE_URL: arkBase,
    VISION_API_KEY: 'ark-vision-key',
    VISION_BASE_URL: arkBase + '/',
  });
  for (const scope of ['llm', 'vision']) {
    const empty = await fetchLlmModels({ scope }, {
      llmRequest: async url => {
        assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/models');
        return response({ data: [] });
      },
    });
    assert.equal(empty.supported, true);
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.models, []);
    assert.match(empty.message, /火山方舟/);
    assert.match(empty.message, /ep-xxx/);
  }

  // 非方舟接口返回空列表时保持既有契约不附加 message
  const genericEmpty = await fetchLlmModels({ apiKey: 'k', baseURL: 'https://generic.example/v1' }, {
    llmRequest: async () => response({ data: [] }),
  });
  assert.equal(genericEmpty.supported, true);
  assert.equal(genericEmpty.count, 0);
  assert.equal('message' in genericEmpty, false);
});

test('前端地址绑定规范化与后端一致，阻止在 /api/v3 与 /api/v3/v1 间串发主模型或识图旧 Key', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const extract = (pattern, label) => {
    const match = source.match(pattern);
    assert.ok(match, '未找到前端函数：' + label);
    return match[0];
  };
  const snippet = [
    extract(/const VERSIONED_BASE_PATH = [^;]+;/, 'VERSIONED_BASE_PATH'),
    extract(/function normalizeBaseUrlForMatch\([\s\S]*?\n  \}/, 'normalizeBaseUrlForMatch'),
    extract(/function normalizeEndpointForBinding\([\s\S]*?\n  \}/, 'normalizeEndpointForBinding'),
    extract(/function hasUnreboundKey\([\s\S]*?\n  \}/, 'hasUnreboundKey'),
    '({ normalizeEndpointForBinding, hasUnreboundKey })',
  ].join('\n');
  const { normalizeEndpointForBinding, hasUnreboundKey } = vm.runInNewContext(snippet, { URL });

  // 与后端 normalizeBaseURL 完全对齐
  for (const url of [
    'https://api.deepseek.com',
    'https://api.deepseek.com/v1/',
    'https://ark.cn-beijing.volces.com/api/v3',
    'https://ark.cn-beijing.volces.com/api/v3/',
    'https://ark.cn-beijing.volces.com/api/v3/v1',
    'https://proxy.example/team',
    'https://proxy.example/team/v1',
  ]) {
    assert.equal(normalizeEndpointForBinding(url), normalizeBaseURL(url), url);
  }

  // 模拟主模型与识图两条入口在 /api/v3 与 /api/v3/v1 之间切换
  for (const [boundUrl, switchedUrl] of [
    ['https://proxy.example/api/v3', 'https://proxy.example/api/v3/v1'],
    ['https://proxy.example/api/v3/v1', 'https://proxy.example/api/v3'],
  ]) {
    const boundEndpoint = normalizeEndpointForBinding(boundUrl);
    // 主模型入口
    assert.equal(hasUnreboundKey('llm-old-key', switchedUrl, boundEndpoint), true);
    // 识图入口
    assert.equal(hasUnreboundKey('vision-old-key', switchedUrl, boundEndpoint), true);
    // 同地址加尾斜杠仍视为已绑定
    assert.equal(hasUnreboundKey('llm-old-key', boundUrl + '/', boundEndpoint), false);
  }
});
