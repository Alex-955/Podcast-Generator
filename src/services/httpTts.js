const { atomicWrite } = require('./atomicWrite');
const { analyzeMp3 } = require('./mp3Utils');
const { TtsCancelledError } = require('./edgeTtsAdapter');
const { InputError } = require('./validation');
const { ProviderError, requestProvider, upstreamError, httpStatusError } = require('./providerHttp');

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

async function synthesizeHttp({ name, endpoint, headers, body, signal, timeoutMs = 60000, outputPath, readAudio,
  allowPrivateEndpoint = process.env.ALLOW_PRIVATE_TTS_ENDPOINT === '1', lookup }) {
  if (signal?.aborted) throw new TtsCancelledError();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  let audio, response;
  try {
    response = await requestProvider(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: controller.signal, allowPrivateEndpoint, lookup,
    });
    // Do not consume untrusted error pages or send credentials to a redirect.
    if (response.statusCode !== 200) throw httpStatusError(response.statusCode);
    audio = await readAudio(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (signal?.aborted) throw new TtsCancelledError();
    if (error instanceof InputError) throw error;
    if (controller.signal.aborted) throw upstreamError(`${name} 请求超时`);
    if (error instanceof ProviderError) throw error;
    throw upstreamError(`${name} 语音接口连接失败`);
  } finally {
    response?.destroy();
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  if (signal?.aborted) throw new TtsCancelledError();
  const analysis = analyzeMp3(audio);
  if (!analysis.ok) throw upstreamError(`${name} 返回的音频不是有效 MP3`);
  try { atomicWrite(outputPath, audio); }
  catch { throw new Error('本地音频文件写入失败'); }
  return { bytes: audio.length, duration: analysis.durationSeconds };
}

module.exports = { synthesizeHttp };
