// Keep the original host for TLS/Host and supply only approved DNS answers to the socket.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const { BlockList, isIP } = require('node:net');
const { InputError, redactSecrets } = require('./validation');

const reserved = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.175.48.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) reserved.addSubnet(network, bits, 'ipv4');
// IPv4-mapped answers also match the IPv4 rules in Node's BlockList.
const allowedV6 = new BlockList();
allowedV6.addSubnet('2000::', 3, 'ipv6');
allowedV6.addSubnet('::ffff:0:0', 96, 'ipv6');
for (const [network, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['2620:4f:8000::', 48]]) {
  reserved.addSubnet(network, bits, 'ipv6');
}

function checkAddress(address, allowPrivate) {
  const family = isIP(address);
  if (!family || (!allowPrivate && (reserved.check(address, family === 4 ? 'ipv4' : 'ipv6') ||
      (family === 6 && !allowedV6.check(address, 'ipv6'))))) {
    throw new InputError('接口地址解析到了受限网络');
  }
}

function checkEndpoint(endpoint, allowPrivate) {
  const url = URL.parse(endpoint);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new InputError('请填写有效的 HTTP 或 HTTPS 接口地址');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) checkAddress(host, allowPrivate);
  else if (!allowPrivate && /(?:^|\.)(?:localhost|local|internal)\.?$/i.test(host)) throw new InputError('接口地址属于受限网络');
  return url;
}

async function requestProvider(endpoint, { method, headers, body, signal, allowPrivateEndpoint = false, lookup = dns.lookup }) {
  const url = checkEndpoint(endpoint, allowPrivateEndpoint);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method, headers, signal, agent: false,
      lookup(hostname, options, callback) {
        Promise.resolve().then(() => lookup(hostname, { all: true })).then(records => {
          if (!records.length) throw new Error('地址解析失败');
          for (const { address } of records) checkAddress(address, allowPrivateEndpoint);
          if (options.all) callback(null, records);
          else callback(null, records[0].address, records[0].family);
        }).catch(callback);
      },
    }, resolve);
    req.on('error', reject);
    req.end(body);
    body = null;
  });
}

class ProviderError extends Error {
  constructor(message, retryable, options = {}) {
    super(message);
    this.statusCode = 502;
    this.retryable = retryable;
    this.rateLimited = Boolean(options.rateLimited);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

function upstreamError(message, retryable = true, options) {
  return new ProviderError(message, retryable, options);
}

async function* boundedChunks(response, limit) {
  if (Number(response.headers['content-length']) > limit) throw upstreamError('上游响应超过大小限制', false);
  let count = 0;
  for await (const chunk of response) {
    count += chunk.length;
    if (count > limit) throw upstreamError('上游响应超过大小限制', false);
    yield chunk;
  }
}

async function readText(response, limit) {
  const chunks = [];
  for await (const chunk of boundedChunks(response, limit)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(response, limit, { allowInvalidJson = false } = {}) {
  const text = await readText(response, limit);
  try { return JSON.parse(text); }
  catch {
    if (allowInvalidJson) return null;
    throw upstreamError('响应不是有效 JSON');
  }
}

function httpStatusError(status) {
  return upstreamError(`HTTP ${status}`, status === 408 || status === 429 || status >= 500, { rateLimited: status === 429 });
}

function chatStatusError(status) {
  if (status === 401 || status === 403) {
    return upstreamError(`模型接口鉴权失败（HTTP ${status}），请检查 API Key、接口地址和模型访问权限`, false);
  }
  if (status === 404) {
    return upstreamError('所选模型或对话接口不存在（HTTP 404），请检查模型名称和接口地址', false);
  }
  if (status === 405) {
    return upstreamError('接口不支持对话请求（HTTP 405），请填写支持对话的接口地址', false);
  }
  return httpStatusError(status);
}

function checkChatCompletion(data, action) {
  const reason = data?.choices?.[0]?.finish_reason;
  if (reason === 'length') throw upstreamError(`${action}结果达到模型输出长度上限，请缩短材料或更换模型后重试`, false);
  if (reason === 'content_filter') throw upstreamError(`${action}结果因服务商内容过滤而中断，请检查材料后重试`, false);
}

function redactProviderDetail(text, sensitive) {
  // Non-ASCII characters also delimit paths in prose without spaces, such as Chinese.
  return redactSecrets(text, sensitive).replace(
    /(^|[\s"'=(\[:]|[^\x00-\x7f])(?:\/[\w.~@%+-]+\/[^\s"'<>),\]，。）】》」』；、]*|[a-z]:(?!\/\/)[\\/][^\s"'<>),\]，。）】》」』；、]+)/giu,
    '$1***'
  );
}

async function withProviderResponse(endpoint, request, {
  llmRequest, timeoutMs, signal, lookup, sensitive, timeoutMessage, connectionMessage,
}, readResponse) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  let response, timer;
  try {
    signal?.throwIfAborted();
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const outbound = { ...request, signal: controller.signal, lookup };
    request = null;
    try {
      response = await llmRequest(endpoint, outbound);
    } finally {
      outbound.body = null;
    }
    controller.signal.throwIfAborted();
    const result = await readResponse(response);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (controller.signal.aborted) throw upstreamError(timeoutMessage);
    if (error instanceof InputError) throw new InputError(redactProviderDetail(error.message, sensitive));
    if (error instanceof ProviderError) {
      throw upstreamError(redactProviderDetail(error.message, sensitive), error.retryable, {
        rateLimited: error.rateLimited, retryAfterMs: error.retryAfterMs,
      });
    }
    throw upstreamError(connectionMessage);
  } finally {
    response?.destroy();
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

module.exports = {
  ProviderError, checkEndpoint, requestProvider, boundedChunks, readText, readJson, upstreamError, httpStatusError,
  chatStatusError, checkChatCompletion, redactProviderDetail, withProviderResponse,
};
