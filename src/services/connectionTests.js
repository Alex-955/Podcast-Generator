const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { InputError, redactSecrets, ttsSecrets } = require('./validation');
const { getCredentials } = require('./llmCredentials');
const { getTtsCredentials, resolveVoiceMapping } = require('./ttsCredentials');
const { getTtsProvider, resolveDefaultProviderId } = require('./ttsProvider');
const { ProviderError, requestProvider, readJson, upstreamError, httpStatusError } = require('./providerHttp');
const { analyzeMp3 } = require('./mp3Utils');

function checkPublicModel(model, credentials) {
  const secrets = [...ttsSecrets(credentials), credentials.baseURL, process.env.DEEPSEEK_API_KEY, process.env.LLM_BASE_URL];
  if (!/^[\w.:-]+(?:\/[\w.:-]+)*$/.test(model) || redactSecrets(model, secrets) !== model) {
    throw new InputError('模型名称无效或包含敏感配置');
  }
}

async function testLlmConnection(payload, { llmRequest = requestProvider } = {}) {
  const creds = getCredentials(payload);
  if (!creds.apiKey) throw new InputError('请先配置模型 API Key');
  const model = creds.model || 'deepseek-flash';
  checkPublicModel(model, creds);
  const base = URL.parse(creds.baseURL);
  if (!base || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new InputError('模型接口地址无效');
  }
  const pathBase = base.pathname.replace(/\/+$/, '');
  base.pathname = pathBase.endsWith('/v1') ? pathBase : pathBase + '/v1';
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  // A private LLM server is trusted only when explicitly configured by the operator.
  const serverBase = URL.parse(process.env.LLM_BASE_URL || '');
  const allowPrivateEndpoint = serverBase?.href === URL.parse(creds.baseURL)?.href;
  async function probe(route, body) {
    const response = await llmRequest(base.href + route, {
      method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal: controller.signal, allowPrivateEndpoint,
      headers: { Authorization: 'Bearer ' + creds.apiKey, 'Content-Type': 'application/json' },
    });
    try {
      if (!body && [404, 405].includes(response.statusCode)) return false;
      if (body && response.statusCode === 404) throw upstreamError('所选模型或对话接口不存在（HTTP 404）', false);
      if (response.statusCode !== 200) throw httpStatusError(response.statusCode);
      const data = await readJson(response, 2 * 1024 * 1024, { allowInvalidJson: !body });
      if (!body) return Array.isArray(data?.data) && data.data.some(item => item?.id === model);
      if (!Array.isArray(data?.choices) || !data.choices.length || data.error) {
        throw upstreamError('模型接口响应格式无效');
      }
      return true;
    } finally { response.destroy(); }
  }
  try {
    if (!await probe('/models')) await probe('/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
    return { ok: true, model, latencyMs: Date.now() - started, message: '连接成功，模型接口可用' };
  } catch (error) {
    if (error instanceof InputError || error instanceof ProviderError) throw error;
    throw upstreamError(controller.signal.aborted ? '模型接口连接超时' : '模型接口连接失败');
  } finally { clearTimeout(timer); }
}

async function testTtsConnection(payload, { getTtsProviderById = getTtsProvider } = {}) {
  const tts = payload.tts || {};
  if (typeof tts !== 'object' || Array.isArray(tts)) throw new InputError('语音配置格式无效');
  let provider;
  try { provider = getTtsProviderById(tts.provider ?? resolveDefaultProviderId()); }
  catch { throw new InputError('未注册的 TTS Provider'); }
  if (!provider) throw new InputError('未注册的 TTS Provider');
  const credentials = getTtsCredentials(provider, tts);
  const model = credentials.model;
  checkPublicModel(model, { ...tts, ...credentials });
  const voices = resolveVoiceMapping(provider, model, tts.voiceMapping);
  const result = { ok: true, provider: provider.id, model };
  if (provider.id === 'edge') return { ...result, latencyMs: 0, duration: 0, message: 'Edge 免密钥，未发起在线合成测试' };
  let dir;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-probe-'));
    const outputPath = path.join(dir, 'probe.mp3');
    await provider.synthesizeToFile({ text: '你好', voice: voices.阿泽, outputPath, signal: controller.signal, adapterOptions: credentials });
    const analysis = analyzeMp3(await fs.readFile(outputPath));
    if (!analysis.ok) throw upstreamError('语音接口返回了无效音频');
    return { ...result, latencyMs: Date.now() - started, duration: analysis.durationSeconds, message: '连接成功，语音合成可用' };
  } catch (error) {
    if (error instanceof InputError || error instanceof ProviderError) throw error;
    throw upstreamError(controller.signal.aborted ? '语音接口连接超时' : '语音接口连接失败');
  } finally {
    clearTimeout(timer);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { testLlmConnection, testTtsConnection };
