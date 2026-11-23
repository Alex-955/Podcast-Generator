const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isValidMp3, getMp3DurationSeconds } = require('./mp3Utils');
const { atomicWrite } = require('./atomicWrite');

function buildCacheKey({ provider, model, voice, rate = '+0%', pitch = '+0Hz', text }) {
  const fields = [provider, model, voice, rate, pitch, text].map(value => String(value).trim().normalize('NFC'));
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function createTtsCache(cacheDir) {
  function getPath(key) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('无效的音频缓存键');
    return path.join(cacheDir, key + '.mp3');
  }

  function get(key, targetPath) {
    const cached = getPath(key);
    if (!fs.existsSync(cached)) return { hit: false };
    const buffer = fs.readFileSync(cached);
    if (!isValidMp3(buffer)) {
      fs.unlinkSync(cached);
      return { hit: false };
    }
    atomicWrite(targetPath, buffer);
    return { hit: true, filePath: targetPath, bytes: buffer.length, duration: getMp3DurationSeconds(buffer) };
  }

  function put(key, sourcePath) {
    const buffer = fs.readFileSync(sourcePath);
    if (!isValidMp3(buffer)) throw new Error('无法缓存无效的 MP3');
    atomicWrite(getPath(key), buffer);
  }

  return { get, put, getPath };
}

module.exports = { buildCacheKey, createTtsCache };
