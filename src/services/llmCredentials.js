const { InputError } = require('./validation');

function normalizeBaseURL(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InputError('使用自定义接口地址时请提供对应的 API Key');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return url.href;
}

function getCredentials(payload) {
  const setting = value => typeof value === 'string' ? value.trim() : '';
  const requestKey = setting(payload.apiKey);
  const apiKey = requestKey || setting(process.env.DEEPSEEK_API_KEY);
  const requestURL = setting(payload.baseURL);
  const serverURL = setting(process.env.LLM_BASE_URL) || 'https://api.deepseek.com';
  if (!requestKey && requestURL && normalizeBaseURL(requestURL) !== normalizeBaseURL(serverURL)) {
    throw new InputError('使用自定义接口地址时请提供对应的 API Key');
  }
  return {
    apiKey,
    baseURL: requestKey && requestURL ? requestURL : serverURL,
    model: setting(payload.model) || setting(process.env.LLM_MODEL) || undefined,
  };
}

module.exports = { getCredentials };
