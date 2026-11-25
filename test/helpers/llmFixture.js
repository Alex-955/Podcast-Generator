const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { PassThrough, Readable } = require('node:stream');

function configureLlm(t, overrides = {}) {
  const settings = {
    DEEPSEEK_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
    VISION_API_KEY: '', VISION_BASE_URL: '', VISION_MODEL: '', ...overrides,
  };
  for (const [name, value] of Object.entries(settings)) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    process.env[name] = value;
  }
}

function response(data, statusCode = 200, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
}

function completion(content) {
  return { choices: [{ message: { content } }] };
}

async function assertCancellationCleanup(t, service, payload, successBody) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const signal = controller.signal;
  const complete = response(successBody);
  let upstreamSignal;
  await service(payload, {
    signal, timeoutMs: 15,
    llmRequest: async (url, args) => {
      upstreamSignal = args.signal;
      return complete;
    },
  });
  assert.equal(complete.destroyed, true);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  t.mock.timers.tick(15);
  assert.equal(upstreamSignal.aborted, false);

  for (const external of [false, true]) {
    const caller = new AbortController();
    const partial = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
    partial.write('{"pending":');
    const result = service(payload, {
      signal: caller.signal, timeoutMs: 15,
      llmRequest: async (url, args) => {
        upstreamSignal = args.signal;
        upstreamSignal.addEventListener('abort', () => partial.destroy(upstreamSignal.reason), { once: true });
        return partial;
      },
    });
    const failed = assert.rejects(result, external
      ? { name: 'AbortError', message: '请求已取消' }
      : { statusCode: 502, message: /超时/ });
    await Promise.resolve();
    assert.equal(getEventListeners(caller.signal, 'abort').length, 1);
    if (external) caller.abort(new Error('private caller details'));
    else t.mock.timers.tick(15);
    await failed;
    assert.equal(partial.destroyed, true);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  }

  const llmRequest = t.mock.fn();
  await assert.rejects(service(payload, { signal: AbortSignal.abort(), llmRequest }), { name: 'AbortError' });
  assert.equal(llmRequest.mock.callCount(), 0);
}

module.exports = { assertCancellationCleanup, completion, configureLlm, response };
