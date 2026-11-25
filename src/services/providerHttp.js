// Keep the original host for TLS/Host and supply only approved DNS answers to the socket.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const { BlockList, isIP } = require('node:net');
const { InputError } = require('./validation');

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
  });
}

class ProviderError extends Error {
  constructor(message, retryable) {
    super(message);
    this.statusCode = 502;
    this.retryable = retryable;
  }
}

function upstreamError(message, retryable = true) {
  return new ProviderError(message, retryable);
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

async function readJson(response, limit) {
  const chunks = [];
  for await (const chunk of boundedChunks(response, limit)) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw upstreamError('响应不是有效 JSON'); }
}

function httpStatusError(status) {
  return upstreamError(`HTTP ${status}`, ![400, 401, 403, 404, 405, 422].includes(status) && !(status >= 300 && status < 400));
}

module.exports = { ProviderError, checkEndpoint, requestProvider, boundedChunks, readJson, upstreamError, httpStatusError };
