'use strict';
/**
 * B-F4 回归子进程：LLM / 抓取连接失败后不得残留超时定时器挟持事件循环。
 * 分别调用 generatePodcastScript（死 baseURL）与 defaultFetcher（死地址，需放开内网校验），
 * 两者都应快速拒绝；随后让事件循环自然排空——若实现里残留 ref'd 定时器
 * （如 axios timeout 选项的 connectPhaseTimer），进程会存活到定时器触发，
 * 父测试按墙钟时间断言失败。
 * 用法：node llmFailChild.js run（由 test/llmDeadline.test.js spawn；
 * 被 node --test 发现时不做任何事）。
 */
// 允许访问 127.0.0.1 测试端点（仅本进程生效，不放宽生产默认）
process.env.ALLOW_PRIVATE_FETCH = '1';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9';

const assert = require('node:assert/strict');
const { generatePodcastScript } = require('../../src/services/scriptEngine');
const { defaultFetcher } = require('../../src/services/extractor');
const { requestProvider } = require('../../src/services/providerHttp');

async function main() {
  let connectionError;
  try {
    await generatePodcastScript({
      title: 't',
      content: 'c',
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:9',
      model: 'm',
      timeoutMs: 4000,
      async llmRequest(url, options) {
        try {
          return await requestProvider(url, options);
        } catch (error) {
          connectionError = error.code;
          throw error;
        }
      },
    });
    console.error('UNEXPECTED_RESOLVE_LLM');
    process.exit(2);
  } catch (error) {
    assert.equal(error.statusCode, 502);
    assert.equal(connectionError, 'ECONNREFUSED');
    console.log('LLM_REJECTED');
  }

  try {
    await defaultFetcher('http://127.0.0.1:9/x', {}, { timeoutMs: 4000 });
    console.error('UNEXPECTED_RESOLVE_FETCH');
    process.exit(3);
  } catch (error) {
    console.log('FETCH_REJECTED');
  }

  // 不调用 process.exit：让事件循环自然排空，暴露残留定时器
}

if (process.argv[2] === 'run') {
  main();
}
