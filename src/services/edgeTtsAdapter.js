/**
 * Edge read-aloud WebSocket TTS 适配层（自建连接与文件生命周期管理）
 *
 * 背景（plan/improvement-roadmap-2026-09-22.md 第 5 节证据）：
 * node-edge-tts@1.2.10 的 ttsPromise 有三个无法通过调参修复的问题——
 *   1) 超时计时从 WebSocket 连接建立后才开始，挂起的握手永远不会超时；
 *   2) 超时仅 reject('Timed out')，不关闭 WebSocket、不结束/销毁文件写入流，
 *      迟到的音频数据仍会写入文件；
 *   3) reject 的是字符串而不是 Error。
 * 因此本模块自行管理连接、写入流与临时文件：
 *
 * - 四级超时语义：connect（握手）/ first-data（首段音频）/ idle（流中空闲）/ task（整项上限，按文本长度缩放）
 * - 超时、出错、取消时：清定时器 → ws.terminate() → stream.destroy() → 删除临时产物
 * - 成功时：收到 turn.end 且写入流 flush 后校验产物可解析出 MP3 时长，再原子 rename 发布
 * - 每次调用使用独立随机后缀临时文件，失败产物绝不进入最终结果
 *
 * 协议与 Sec-MS-GEC token 算法按 node-edge-tts@1.2.10 源码复刻；
 * 微软调整协议/令牌时需要同步维护本文件（见 b0-report.md 风险说明）。
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getMp3DurationSeconds, isValidMp3 } = require('./mp3Utils');

const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const DEFAULT_ENDPOINT =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const DEFAULT_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const AUDIO_SEPARATOR = 'Path:audio\r\n';

class TtsTimeoutError extends Error {
  constructor(phase, ms, textLength) {
    super(`Edge TTS ${phase} 阶段超时（${ms}ms，文本 ${textLength} 字）`);
    this.name = 'TtsTimeoutError';
    this.phase = phase;
  }
}

class TtsCancelledError extends Error {
  constructor() {
    super('合成已取消');
    this.name = 'AbortError';
  }
}

class TtsUpstreamError extends Error {
  constructor(phase, message) {
    super(message);
    this.name = 'TtsUpstreamError';
    this.phase = phase;
  }
}

/** 与 node-edge-tts/drm.js 相同算法：Windows FILE_TIME 百万纳秒 tick，按 300s 取整后哈希 */
function generateSecMsGecToken() {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n);
  return crypto
    .createHash('sha256')
    .update(`${roundedTicks}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function buildWsUrl(endpoint) {
  const url = new URL(endpoint);
  url.searchParams.set('TrustedClientToken', TRUSTED_CLIENT_TOKEN);
  url.searchParams.set('Sec-MS-GEC', generateSecMsGecToken());
  url.searchParams.set('Sec-MS-GEC-Version', `1-${CHROMIUM_FULL_VERSION}`);
  return url.toString();
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, { voice, lang, rate, pitch, volume }) {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">` +
    `<voice name="${voice}">` +
    `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">` +
    escapeXml(text) +
    `</prosody></voice></speak>`
  );
}

function buildSpeechConfig(outputFormat) {
  return (
    'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: 'false',
              wordBoundaryEnabled: 'true',
            },
            outputFormat,
          },
        },
      },
    })
  );
}

class EdgeTtsAdapter {
  constructor(options = {}) {
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
    this.voice = options.voice || 'zh-CN-YunxiNeural';
    this.lang = options.lang || 'zh-CN';
    this.rate = options.rate || 'default';
    this.pitch = options.pitch || 'default';
    this.volume = options.volume || 'default';
    this.outputFormat = options.outputFormat || DEFAULT_OUTPUT_FORMAT;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.firstDataTimeoutMs = options.firstDataTimeoutMs ?? 10000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10000;
    // 整项上限：15s 固定开销 + 按 5 字/秒 的语音时长估算（长文本不被短时限误杀）
    this.taskTimeoutMs = options.taskTimeoutMs ?? null;
  }

  /**
   * 合成一段文本到目标文件。成功时产物已原子发布到 targetPath；
   * 失败/超时/取消时不留下任何文件（临时产物会被删除）。
   *
   * @returns {Promise<{filePath: string, bytes: number}>}
   */
  synthesizeToFile(text, targetPath, { signal } = {}) {
    if (typeof text !== 'string' || !text.trim()) {
      return Promise.reject(new Error('合成文本必须是非空字符串'));
    }
    const textLength = text.length;
    const taskTimeoutMs = this.taskTimeoutMs ?? 15000 + Math.ceil(textLength / 5) * 1000;

    const dir = path.dirname(targetPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      // setup 阶段异常同样以 Promise 拒绝交付，不以同步 throw 逸出（B-F1）
      return Promise.reject(error);
    }
    const tmpPath = path.join(
      dir,
      `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );

    return new Promise((resolve, reject) => {
      let settled = false;    // 只在真正 resolve/reject 时置位（B-F1）
      let finalizing = false; // turn.end 之后的 flush/publish 阶段
      let tornDown = false;   // 资源清理幂等标记
      let phase = 'connect'; // connect → await-first-data → streaming → done
      let ws = null;
      let stream = null;
      let connectTimer = null;
      let idleTimer = null;
      let taskTimer = null;

      const clearTimers = () => {
        if (connectTimer) clearTimeout(connectTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (taskTimer) clearTimeout(taskTimer);
        connectTimer = idleTimer = taskTimer = null;
      };

      // B-F1：资源清理幂等，且不移除 ws 监听器。
      // CONNECTING 状态下 terminate() 会异步发出 'error'，若此时已 removeAllListeners，
      // 该事件会升级为未捕获异常导致整个进程退出；保留监听到连接真正结束，
      // 迟到事件走 fail() 幂等路径被安全忽略。
      const teardownResources = () => {
        if (tornDown) return;
        tornDown = true;
        clearTimers();
        if (signal) signal.removeEventListener('abort', onAbort);
        if (ws) {
          try {
            ws.terminate(); // 真正断开连接，杜绝孤儿 WS 与迟到数据
          } catch {
            /* ignore */
          }
        }
        if (stream && !stream.destroyed) {
          stream.destroy(); // 真正停止写入
        }
      };

      // 统一 settle 入口：settled 只在真正 resolve/reject 时置位，
      // flush/publish 期间的异常同样走 settleReject，不会被吞或让 Promise 悬空。
      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        teardownResources();
        resolve(value);
      };

      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        teardownResources();
        fs.rm(tmpPath, { force: true }, () => reject(error));
      };

      const fail = (error) => settleReject(error);

      const complete = () => {
        if (settled || finalizing) return;
        finalizing = true;
        phase = 'done';
        clearTimers();
        if (signal) signal.removeEventListener('abort', onAbort);
        if (ws) {
          try {
            ws.close(); // 温和关闭；不移除监听器，等连接真正结束（B-F1）
          } catch {
            /* ignore */
          }
        }
        stream.end(() => {
          if (settled) {
            // 发布前已被取消/失败（与异步 fs.rm 的竞态）：只清理，绝不发布（B-F1）
            fs.rm(tmpPath, { force: true }, () => {});
            return;
          }
          try {
            const buffer = fs.readFileSync(tmpPath);
            if (!isValidMp3(buffer)) {
              throw new TtsUpstreamError('protocol', '合成产物不是完整有效的 MP3（帧不完整或格式不一致）');
            }
            fs.renameSync(tmpPath, targetPath); // 校验通过后原子发布
            settleResolve({ filePath: targetPath, bytes: buffer.length, duration: getMp3DurationSeconds(buffer) });
          } catch (error) {
            settleReject(error);
          }
        });
      };

      const onAbort = () => fail(new TtsCancelledError());
      if (signal) {
        if (signal.aborted) return fail(new TtsCancelledError());
        signal.addEventListener('abort', onAbort, { once: true });
      }

      stream = fs.createWriteStream(tmpPath);
      stream.on('error', (error) => fail(new TtsUpstreamError('io', `音频写入失败：${error.message}`)));

      // 任务总超时（覆盖连接建立在内的全生命周期）
      taskTimer = setTimeout(() => fail(new TtsTimeoutError('task', taskTimeoutMs, textLength)), taskTimeoutMs);
      // 连接建立超时（修复：超时不覆盖连接阶段的问题）
      connectTimer = setTimeout(
        () => fail(new TtsTimeoutError('connect', this.connectTimeoutMs, textLength)),
        this.connectTimeoutMs
      );

      try {
        ws = new WebSocket(buildWsUrl(this.endpoint), {
          host: new URL(this.endpoint).hostname,
          origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          headers: {
            Pragma: 'no-cache',
            'Cache-Control': 'no-cache',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          handshakeTimeout: this.connectTimeoutMs,
        });
      } catch (error) {
        return fail(new TtsUpstreamError('connect', `无法创建 WebSocket：${error.message}`));
      }

      const armIdleTimer = (ms) => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const p = phase === 'await-first-data' ? 'first-data' : 'idle';
          fail(new TtsTimeoutError(p, ms, textLength));
        }, ms);
      };

      ws.on('open', () => {
        phase = 'await-first-data';
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        armIdleTimer(this.firstDataTimeoutMs);
        ws.send(buildSpeechConfig(this.outputFormat));
        const requestId = crypto.randomBytes(16).toString('hex');
        ws.send(
          `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
            buildSsml(text, {
              voice: this.voice,
              lang: this.lang,
              rate: this.rate,
              pitch: this.pitch,
              volume: this.volume,
            })
        );
      });

      ws.on('message', (data, isBinary) => {
        if (settled || finalizing) return; // B-F1：发布阶段不再接收数据
        if (isBinary) {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const index = buffer.indexOf(AUDIO_SEPARATOR);
          if (index === -1) {
            return fail(new TtsUpstreamError('protocol', '音频数据包缺少 Path:audio 分隔符'));
          }
          const payload = buffer.subarray(index + AUDIO_SEPARATOR.length);
          if (payload.length > 0) {
            if (phase === 'await-first-data') phase = 'streaming';
            stream.write(payload);
          }
          armIdleTimer(this.idleTimeoutMs);
          return;
        }
        const message = data.toString();
        if (message.includes('Path:turn.end')) {
          return complete();
        }
        // Path:audio.metadata 等元数据消息：只刷新空闲计时
        armIdleTimer(phase === 'await-first-data' ? this.firstDataTimeoutMs : this.idleTimeoutMs);
      });

      // B-F1：连接级事件在 finalizing/已 settle 后属正常收尾或迟到事件，忽略之；
      // 其余时刻必须 settle，保证 close / 取消 / 超时幂等且 Promise 不悬挂。
      ws.on('error', (error) => {
        if (finalizing || settled) return;
        fail(new TtsUpstreamError(phase, `Edge TTS 连接错误（${phase}）：${error.message}`));
      });

      ws.on('close', () => {
        if (finalizing || settled) return;
        fail(new TtsUpstreamError(phase, `Edge TTS 连接提前关闭（${phase}），音频不完整`));
      });
    });
  }
}

module.exports = {
  EdgeTtsAdapter,
  TtsTimeoutError,
  TtsCancelledError,
  TtsUpstreamError,
  generateSecMsGecToken,
  buildWsUrl,
  buildSsml,
};
