const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { InputError, ttsSecrets } = require('./validation');
const { checkPublicModel, getCredentials, llmSecrets, validateLlmSettings } = require('./llmCredentials');
const { getTtsCredentials, resolveVoiceMapping } = require('./ttsCredentials');
const { getTtsProvider, resolveDefaultProviderId } = require('./ttsProvider');
const { ProviderError, chatStatusError, redactProviderDetail, requestProvider, readJson, upstreamError } = require('./providerHttp');
const { analyzeMp3 } = require('./mp3Utils');

async function testLlmConnection(payload, { llmRequest = requestProvider, lookup, signal } = {}) {
  const creds = getCredentials(payload);
  if (!creds.apiKey) throw new InputError('请先配置模型 API Key');
  const { baseURL, model, sensitive, allowPrivateEndpoint } = validateLlmSettings(payload, creds);
  const started = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), 10000);
  async function probe(route, body) {
    const response = await llmRequest(baseURL + route, {
      method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal: controller.signal, allowPrivateEndpoint, lookup,
      headers: { Authorization: 'Bearer ' + creds.apiKey, 'Content-Type': 'application/json' },
    });
    try {
      controller.signal.throwIfAborted();
      if (!body && [404, 405].includes(response.statusCode)) return false;
      if (response.statusCode !== 200) throw chatStatusError(response.statusCode);
      const data = await readJson(response, 2 * 1024 * 1024, { allowInvalidJson: !body });
      controller.signal.throwIfAborted();
      if (!body) return !data?.error && Array.isArray(data?.data) && data.data.some(item => item?.id === model);
      const first = data?.choices?.[0];
      const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
      const hasText = nonEmpty(first?.message?.content) || nonEmpty(first?.message?.reasoning_content) || nonEmpty(first?.text);
      if (data?.error || !Array.isArray(data?.choices) || !first || typeof first !== 'object' || Array.isArray(first) || !hasText) {
        throw upstreamError('模型接口响应格式无效');
      }
      return true;
    } finally { response.destroy(); }
  }
  try {
    if (payload?.verifyChat === true || !await probe('/models')) {
      await probe('/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
    }
    return { ok: true, model, latencyMs: Date.now() - started, message: '连接成功，模型接口可用' };
  } catch (error) {
    if (error instanceof InputError) throw new InputError(redactProviderDetail(error.message, sensitive));
    if (error instanceof ProviderError) {
      error.message = redactProviderDetail(error.message, sensitive);
      throw error;
    }
    throw upstreamError(controller.signal.aborted ? '模型接口连接超时' : '模型接口连接失败');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function testTtsConnection(payload, { getTtsProviderById = getTtsProvider, signal } = {}) {
  const tts = payload.tts || {};
  if (typeof tts !== 'object' || Array.isArray(tts)) throw new InputError('语音配置格式无效');
  let provider;
  try { provider = getTtsProviderById(tts.provider ?? resolveDefaultProviderId()); }
  catch { throw new InputError('未注册的 TTS Provider'); }
  if (!provider) throw new InputError('未注册的 TTS Provider');
  const credentials = getTtsCredentials(provider, tts);
  const model = credentials.model;
  checkPublicModel(model, [...llmSecrets(tts, credentials), ...ttsSecrets({ ...tts, ...credentials })]);
  const voices = resolveVoiceMapping(provider, model, tts.voiceMapping);
  const result = { ok: true, provider: provider.id, model };
  if (provider.id === 'edge') return { ...result, latencyMs: 0, duration: 0, message: 'Edge 免密钥，未发起在线合成测试' };
  let dir;
  const started = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-probe-'));
    controller.signal.throwIfAborted();
    const outputPath = path.join(dir, 'probe.mp3');
    await provider.synthesizeToFile({ text: '你好', voice: voices.阿泽, outputPath, signal: controller.signal, adapterOptions: credentials });
    controller.signal.throwIfAborted();
    const analysis = analyzeMp3(await fs.readFile(outputPath));
    if (!analysis.ok) throw upstreamError('语音接口返回了无效音频');
    return { ...result, latencyMs: Date.now() - started, duration: analysis.durationSeconds, message: '连接成功，语音合成可用' };
  } catch (error) {
    if (error instanceof InputError || error instanceof ProviderError) throw error;
    throw upstreamError(controller.signal.aborted ? '语音接口连接超时' : '语音接口连接失败');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { testLlmConnection, testTtsConnection };
