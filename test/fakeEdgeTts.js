'use strict';
/**
 * 假 Edge TTS WebSocket 服务器（仅测试用，绑定 127.0.0.1）。
 * 复刻适配层依赖的最小协议行为：二进制 `Path:audio\r\n` + MP3 载荷、文本 `Path:turn.end`。
 *
 * mode：
 * - 'ok'           分片发送完整音频后发 turn.end
 * - 'no-data'      收到 SSML 后不回任何数据（触发 first-data 超时）
 * - 'stall-mid'    只发半份音频就停住（触发 idle 超时）
 * - 'garbage'      发送带分隔符但非 MP3 的载荷 + turn.end（触发产物校验失败）
 * - 'truncated-mp3' 只发首帧前 5 字节的残缺载荷 + turn.end（B-F2：残缺产物不得发布）
 * - 'no-separator' 发送缺少 Path:audio 分隔符的二进制（触发协议错误）
 * - 'close-early'  收到 SSML 后直接断开（触发提前关闭）
 * - 'late'         延迟 delayMs 后再发完整音频（检验首包超时阈值）
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const AUDIO_SEPARATOR = 'Path:audio\r\n';

function binaryAudio(payload) {
  return Buffer.concat([Buffer.from(AUDIO_SEPARATOR, 'utf8'), payload]);
}

function runBehavior(ws, conn, payload, delayMs) {
  const turnEnd = 'X-RequestId:test\r\nPath:turn.end\r\n';
  const half = payload.subarray(0, Math.max(1, Math.floor(payload.length / 2)));

  switch (conn.mode) {
    case 'no-data':
      return;
    case 'late':
      setTimeout(() => {
        ws.send(binaryAudio(payload));
        ws.send(turnEnd);
      }, delayMs);
      return;
    case 'stall-mid':
      ws.send(binaryAudio(half));
      return;
    case 'garbage':
      ws.send(binaryAudio(Buffer.from('这不是 MP3 数据，仅用于触发产物校验失败')));
      ws.send(turnEnd);
      return;
    case 'truncated-mp3':
      // 只发首帧前 5 字节的残片：旧实现会误判为 0.024s 有效 MP3（B-F2 复现场景）
      ws.send(binaryAudio(payload.subarray(0, 5)));
      ws.send(turnEnd);
      return;
    case 'no-separator':
      ws.send(payload);
      return;
    case 'close-early':
      ws.close();
      return;
    case 'ok':
    default:
      ws.send(binaryAudio(half), () => {
        ws.send(binaryAudio(payload.subarray(half.length)), () => ws.send(turnEnd));
      });
  }
}

function startFakeEdgeTts(options = {}) {
  const { mode = 'ok', payload, delayMs = 30, onConnection = null } = options;
  if (!payload || !Buffer.isBuffer(payload)) {
    return Promise.reject(new Error('startFakeEdgeTts 需要 payload（Buffer）'));
  }

  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const connections = [];

  wss.on('connection', (ws) => {
    const conn = { index: connections.length, mode };
    connections.push(conn);
    if (typeof onConnection === 'function') onConnection(conn);

    ws.on('message', (raw) => {
      const text = raw.toString();
      // 适配层先发 speech.config，收到 SSML 才开始本次合成行为
      if (!text.includes('Path:ssml')) return;
      runBehavior(ws, conn, payload, delayMs);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        endpoint: `ws://127.0.0.1:${port}`,
        connections,
        close: () =>
          new Promise((done) => {
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { startFakeEdgeTts, AUDIO_SEPARATOR };
