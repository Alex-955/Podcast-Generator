const { InputError, ttsSecrets } = require('./validation');
const { checkEndpoint, redactProviderDetail } = require('./providerHttp');

const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const MODEL_ID = /^[\w.:-]+(?:\/[\w.:-]+)*$/;

function setting(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseURL(value) {
  const url = URL.parse(setting(value));
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.href.includes('?') || url.href.includes('#')) return undefined;
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : pathname + '/v1';
  return url.href;
}

function llmSecrets(payload, { apiKey, baseURL }, { includeDefaultBase = true } = {}) {
  const env = process.env;
  const urls = [baseURL, payload.baseURL, payload.visionBaseURL, env.LLM_BASE_URL, env.VISION_BASE_URL]
    .filter(url => includeDefaultBase || normalizeBaseURL(url) !== DEFAULT_BASE_URL + '/v1');
  const normalized = urls.map(normalizeBaseURL).filter(Boolean);
  return [apiKey, payload.apiKey, payload.visionApiKey, env.DEEPSEEK_API_KEY, env.VISION_API_KEY,
    ...urls, ...normalized, ...normalized.map(url => url.slice(0, -'/v1'.length)),
    ...ttsSecrets(payload?.tts ?? {}), process.cwd(), env.DATA_DIR, env.PODCASTS_DIR];
}

function checkCallerKeyEndpoint(payload) {
  if (setting(payload.apiKey) && !setting(payload.baseURL)) {
    throw new InputError('填写自定义 API Key 时，请同时填写对应的接口地址（Base URL）');
  }
}

function isPublicModel(id, sensitive) {
  return typeof id === 'string' && id.length <= 160 && !/\s/.test(id) && MODEL_ID.test(id) &&
    !/^[a-z]:/i.test(id) && !id.split('/').some(segment => segment === '.' || segment === '..') &&
    redactProviderDetail(id, sensitive) === id;
}

function checkPublicModel(model, sensitive) {
  if (!isPublicModel(model, sensitive)) throw new InputError('模型名称无效或包含敏感配置');
}

function checkModelInputs(payload, sensitive) {
  for (const key of ['model', 'visionModel']) {
    if (!Object.hasOwn(payload, key) || payload[key] === undefined) continue;
    const model = payload[key];
    if (typeof model !== 'string') throw new InputError('模型名称无效或包含敏感配置');
    if (model !== '') checkPublicModel(model, sensitive);
  }
}

function validateLlmSettings(payload, credentials) {
  const sensitive = llmSecrets(payload, credentials);
  checkModelInputs(payload, sensitive);
  const model = credentials.model || DEFAULT_MODEL;
  checkPublicModel(model, sensitive);
  const baseURL = normalizeBaseURL(credentials.baseURL);
  if (!baseURL) throw new InputError('模型接口地址无效');
  const allowPrivateEndpoint = baseURL === normalizeBaseURL(process.env.LLM_BASE_URL);
  checkEndpoint(baseURL, allowPrivateEndpoint);
  return { baseURL, model, sensitive, allowPrivateEndpoint };
}

function getCredentials(payload) {
  checkCallerKeyEndpoint(payload);
  const requestKey = setting(payload.apiKey);
  const apiKey = requestKey || setting(process.env.DEEPSEEK_API_KEY);
  const requestURL = setting(payload.baseURL);
  const serverURL = setting(process.env.LLM_BASE_URL) || DEFAULT_BASE_URL;
  if (!requestKey && requestURL) {
    const requestBase = normalizeBaseURL(requestURL);
    if (!requestBase || requestBase !== normalizeBaseURL(serverURL)) {
      throw new InputError('使用自定义接口地址时请提供对应的 API Key');
    }
  }
  return {
    apiKey,
    baseURL: requestKey ? requestURL : serverURL,
    model: setting(payload.model) || setting(process.env.LLM_MODEL) || undefined,
  };
}

module.exports = {
  DEFAULT_MODEL, checkCallerKeyEndpoint, checkModelInputs, checkPublicModel, getCredentials, isPublicModel,
  llmSecrets, normalizeBaseURL, setting, validateLlmSettings,
};
