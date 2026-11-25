// The deadline covers both the HTTP request and consumption of the audio body.
const { atomicWrite } = require('./atomicWrite');
const { analyzeMp3 } = require('./mp3Utils');
const { TtsCancelledError } = require('./edgeTtsAdapter');
const { redactSecrets } = require('./validation');

async function synthesizeHttp({ name, endpoint, headers, body, signal, timeoutMs = 60000, outputPath, secrets, readAudio }) {
  if (signal?.aborted) throw new TtsCancelledError();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  let audio;
  try {
    // Custom authentication headers must never be forwarded to a redirect target.
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`HTTP ${response.status} ${detail}`);
    }
    audio = await readAudio(response);
  } catch (error) {
    if (signal?.aborted) throw new TtsCancelledError();
    const detail = controller.signal.aborted ? '请求超时' : redactSecrets(error.message, [...secrets, endpoint]);
    throw Object.assign(new Error(`${name} 语音合成失败：${detail.slice(0, 300)}`), { statusCode: 502 });
  } finally {
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  if (signal?.aborted) throw new TtsCancelledError();
  const analysis = analyzeMp3(audio);
  if (!analysis.ok) throw new Error(`${name} 返回的音频不是有效 MP3`);
  try { atomicWrite(outputPath, audio); }
  catch { throw new Error('本地音频文件写入失败'); }
  return { bytes: audio.length, duration: analysis.durationSeconds };
}

module.exports = { synthesizeHttp };
