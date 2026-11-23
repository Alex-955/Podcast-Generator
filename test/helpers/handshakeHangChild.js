'use strict';
/**
 * B-F1 回归子进程：对「接受 TCP 但永不完成 WS 握手」的本地服务器发起合成，
 * 分别触发 connect 超时与取消（CONNECTING 状态 teardown）两个场景。
 *
 * 用法：node handshakeHangChild.js <timeout|cancel>（由 ttsAdapterLifecycle.test.js spawn）。
 * 未带模式参数（例如被 node --test 作为测试文件发现）时不做任何事。
 *
 * 判定方式：
 * - 预期 Promise 明确拒绝、无任何文件残留、无未关闭连接，随后 process.exit(0)；
 * - 若适配层把异步 ws 'error' 升级为未捕获异常（removeAllListeners 后 terminate 的经典崩溃），
 *   Node 会以非零码退出，父测试据此判定回归。
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EdgeTtsAdapter } = require('../../src/services/edgeTtsAdapter');

const mode = process.argv[2];

if (mode === 'timeout' || mode === 'cancel') {
  main(mode);
}

function main(activeMode) {
  const openSockets = new Set();

  const server = net.createServer((socket) => {
    openSockets.add(socket);
    // 必须消费读侧数据：客户端发来的握手请求字节若滞留在缓冲区，远端关闭后 'end'/'close' 不会触发，
    // 「无未关闭连接」自检将永远失败。这里读走并丢弃，同时保持「永不完成 WS 握手」。
    socket.on('data', () => {});
    socket.on('close', () => openSockets.delete(socket));
  });

  setTimeout(() => {
    console.error('CHILD_GUARD_TIMEOUT');
    process.exit(5);
  }, 8000);

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const dir = path.join(os.tmpdir(), `bf1-${activeMode}-${process.pid}`);
    const target = path.join(dir, 'sentence_000.mp3');
    const adapter = new EdgeTtsAdapter({
      endpoint: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 200,
      firstDataTimeoutMs: 300,
      idleTimeoutMs: 300,
      taskTimeoutMs: 5000,
    });
    const controller = new AbortController();
    if (activeMode === 'cancel') {
      setTimeout(() => controller.abort(), 30);
    }

    try {
      await adapter.synthesizeToFile('测试句子', target, { signal: controller.signal });
      console.error('UNEXPECTED_RESOLVE');
      process.exit(2);
    } catch (error) {
      // 预期拒绝；等迟到的异步事件落地后自检
      await new Promise((r) => setTimeout(r, 120));
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const leftovers = files.filter((f) => f.includes('.tmp-') || f === 'sentence_000.mp3');
      if (leftovers.length > 0) {
        console.error(`LEFTOVER_FILES:${leftovers.join(',')}`);
        process.exit(3);
      }
      if (openSockets.size > 0) {
        console.error(`OPEN_SOCKETS:${openSockets.size}`);
        process.exit(4);
      }
      // 打印类名而非 error.name（TtsCancelledError 按约定 name='AbortError'）
      console.log(`REJECTED_OK:${error.constructor.name}:${error.phase || ''}`);
      process.exit(0);
    }
  });
}
