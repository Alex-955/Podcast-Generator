const { resolveVisionCredentials } = require('./imageExtractor');
const { checkModelInputs, getCredentials, isPublicModel, llmSecrets, normalizeBaseURL, setting } = require('./llmCredentials');
const { checkEndpoint, httpStatusError, readJson, redactProviderDetail, requestProvider, upstreamError,
  withProviderResponse } = require('./providerHttp');
const { InputError } = require('./validation');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 500;

function isVolcArkBaseURL(baseURL) {
  const url = URL.parse(baseURL);
  return Boolean(url && /(?:^|\.)(?:volces\.com|bytepluses\.com)$/i.test(url.hostname) && /(?:^|\.)ark(?:\.|$)/i.test(url.hostname));
}

function resolveLlmListCredentials(payload) {
  const credentials = getCredentials(payload);
  if (!credentials.apiKey) throw new InputError('请先填写 API Key 再获取模型列表');
  const sensitive = llmSecrets(payload, credentials);
  checkModelInputs(payload, sensitive);
  const baseURL = normalizeBaseURL(credentials.baseURL);
  if (!baseURL) throw new InputError('模型接口地址无效');
  const allowPrivateEndpoint = [process.env.LLM_BASE_URL, process.env.VISION_BASE_URL]
    .some(value => baseURL === normalizeBaseURL(value));
  checkEndpoint(baseURL, allowPrivateEndpoint);
  return { apiKey: credentials.apiKey, baseURL, allowPrivateEndpoint, sensitive };
}

async function fetchLlmModels(payload = {}, options = {}) {
  const { scope = 'llm' } = payload;
  if (scope !== 'llm' && scope !== 'vision') throw new InputError('模型列表查询范围无效');
  const credentials = scope === 'vision'
    ? resolveVisionCredentials(payload, { requireModel: false })
    : resolveLlmListCredentials(payload);
  const { apiKey, baseURL, allowPrivateEndpoint, sensitive } = credentials;
  const started = Date.now();
  return withProviderResponse(baseURL + '/models', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
    allowPrivateEndpoint,
  }, {
    ...options, llmRequest: options.llmRequest || requestProvider, timeoutMs: options.timeoutMs ?? 12000, sensitive,
    timeoutMessage: '获取模型列表超时，请重试', connectionMessage: '模型列表接口连接失败',
  }, async response => {
    const { statusCode } = response;
    if (statusCode === 404 || statusCode === 405) {
      const message = isVolcArkBaseURL(baseURL)
        ? '当前火山方舟接口未开放自动拉取模型列表，请直接手动填写火山方舟模型 ID 或推理接入点 ID（如 ep-xxx）'
        : '该接口暂未开放自动拉取模型列表，请直接手动填写模型名称';
      return { supported: false, models: [], count: 0, latencyMs: Date.now() - started, message };
    }
    if (statusCode === 401 || statusCode === 403) {
      throw upstreamError(`鉴权失败或该地址不支持通用接口访问（HTTP ${statusCode}），请检查 API Key 或所选接口体系`, false);
    }
    if (statusCode !== 200) throw httpStatusError(statusCode);
    const data = await readJson(response, MAX_RESPONSE_BYTES);
    const entries = Array.isArray(data?.data) ? data.data : data?.models;
    if (data?.error || !Array.isArray(entries)) throw upstreamError('模型列表响应格式无效');
    const models = [];
    const seen = new Set();
    for (const item of entries) {
      const id = typeof item === 'string' ? item : item?.id;
      if (seen.has(id) || !isPublicModel(id, sensitive)) continue;
      seen.add(id);
      models.push({ id, ownedBy: redactProviderDetail(setting(item?.owned_by), sensitive) });
      if (models.length === MAX_MODELS) break;
    }
    const emptyMessage = models.length === 0 && isVolcArkBaseURL(baseURL)
      ? '接口鉴权通过，但未返回可用模型，请直接手动填写火山方舟模型 ID 或推理接入点 ID（如 ep-xxx）'
      : undefined;
    return {
      supported: true,
      models,
      count: models.length,
      latencyMs: Date.now() - started,
      ...(emptyMessage ? { message: emptyMessage } : {}),
    };
  });
}

module.exports = { fetchLlmModels };
