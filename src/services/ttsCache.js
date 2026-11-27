const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { analyzeMp3, isValidMp3 } = require('./mp3Utils');
const { atomicWrite } = require('./atomicWrite');

function speechScopeHash(endpoint, credentials, voices, publicVoices, officialEndpoint, toneVersion) {
  const normalizedEndpoint = new URL(endpoint).href;
  const scope = [normalizedEndpoint];
  if (normalizedEndpoint !== officialEndpoint || voices.some(voice => !publicVoices.some(item => item.id === voice))) {
    const apiKey = credentials.apiKey?.trim();
    if (apiKey) scope.push(apiKey, '', '');
    else scope.push('', credentials.appId?.trim() || '', credentials.accessKey?.trim() || '');
  }
  if (typeof toneVersion === 'string' && toneVersion.trim()) scope.push(toneVersion.trim());
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

function buildCacheKey({ provider, model, voice, rate = '+0%', pitch = '+0Hz', emotion = '', text, scopeHash, toneVersion }) {
  const fields = [provider, model, voice, rate, pitch, text].map(value => String(value).trim().normalize('NFC'));
  if (scopeHash) fields.push(scopeHash);
  if (typeof emotion === 'string' && emotion.trim()) fields.push(emotion.trim().normalize('NFC'));
  if (typeof toneVersion === 'string' && toneVersion.trim()) fields.push(['toneVersion', toneVersion.trim()]);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

const CACHE_FILENAME = /^[a-f0-9]{64}\.mp3$/;
const TEMP_FILENAME = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60_000;
const statEntry = file => fs.lstatSync(file, { throwIfNoEntry: false });

function createTtsCache(directory, {
  maxBytes = 200 * 1024 * 1024,
  maxFiles = 2000,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now,
} = {}) {
  const cacheDir = path.join(directory, '.');
  let usage;

  function getPath(key) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('无效的音频缓存键');
    return path.join(cacheDir, key + '.mp3');
  }

  function touch(file, time) {
    try {
      fs.utimesSync(file, time / 1000, time / 1000);
    } catch {
      // Cache reads and writes remain usable if the volume disallows timestamp changes.
    }
  }

  function remove(file) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function removeExpiredTemp(file, stat, directory) {
    const same = (a, b) => a && a.dev === b.dev && a.ino === b.ino;
    const eligible = candidate => {
      const current = statEntry(candidate);
      return current?.isFile() && same(current, stat) && current.mtimeMs === stat.mtimeMs &&
        same(statEntry(cacheDir), directory);
    };
    if (!eligible(file)) return;
    // Take the name out of circulation before unlinking. A replacement in the
    // check/rename window must survive, as must any new file at the old name.
    const claimed = path.join(cacheDir, '.tmp-' + randomUUID());
    try {
      fs.renameSync(file, claimed);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!eligible(claimed)) {
      // Restore a replacement only if its original name is still available.
      // If another writer took that name, preserve both files.
      try {
        fs.linkSync(claimed, file);
      } catch (error) {
        if (error.code === 'EEXIST' || error.code === 'ENOENT') return;
        throw error;
      }
    }
    remove(claimed);
  }

  function prune({ protectKey } = {}) {
    const protectedName = protectKey === undefined ? null : path.basename(getPath(protectKey));
    const directory = statEntry(cacheDir);
    if (!directory?.isDirectory()) {
      usage = undefined;
      return;
    }
    const time = now();
    const candidates = [];
    let bytes = 0, count = 0, oldestMtime = Infinity;
    for (const name of fs.readdirSync(cacheDir)) {
      const temp = TEMP_FILENAME.test(name);
      if (!temp && !CACHE_FILENAME.test(name)) continue;
      const file = path.join(cacheDir, name);
      const stat = statEntry(file);
      if (!stat?.isFile()) continue;
      if (temp) {
        if (time - stat.mtimeMs > TEMP_MAX_AGE_MS) removeExpiredTemp(file, stat, directory);
        continue;
      }
      if (name !== protectedName && time - stat.mtimeMs > maxAgeMs) {
        remove(file);
        continue;
      }
      bytes += stat.size;
      count++;
      oldestMtime = Math.min(oldestMtime, stat.mtimeMs);
      if (name !== protectedName) candidates.push({ file, name, size: stat.size, mtime: stat.mtimeMs });
    }
    if (bytes > maxBytes || count > maxFiles) {
      candidates.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
      for (const { file, size } of candidates) {
        remove(file);
        bytes -= size;
        count--;
        if (bytes <= maxBytes && count <= maxFiles) break;
      }
    }
    usage = { bytes, count, oldestMtime, scannedAt: time };
  }

  function get(key, targetPath) {
    const cached = getPath(key);
    if (!statEntry(cacheDir)?.isDirectory()) return { hit: false };
    const stat = statEntry(cached);
    const time = now();
    if (!stat?.isFile() || time - stat.mtimeMs > maxAgeMs) return { hit: false };
    const buffer = fs.readFileSync(cached);
    const { ok, durationSeconds } = analyzeMp3(buffer);
    if (!ok) {
      remove(cached);
      usage = undefined;
      return { hit: false };
    }
    atomicWrite(targetPath, buffer);
    if (stat.nlink === 1) touch(cached, time);
    return { hit: true, filePath: targetPath, bytes: buffer.length, duration: durationSeconds };
  }

  function put(key, sourcePath) {
    const cached = getPath(key);
    const directory = statEntry(cacheDir);
    if (directory && !directory.isDirectory()) throw new Error('音频缓存目录无效');
    const buffer = fs.readFileSync(sourcePath);
    if (!isValidMp3(buffer)) throw new Error('无法缓存无效的 MP3');
    const previous = usage && statEntry(cached);
    atomicWrite(cached, buffer);
    const time = now();
    touch(cached, time);
    if (usage) {
      usage.bytes += buffer.length - (previous?.isFile() ? previous.size : 0);
      if (!previous?.isFile()) usage.count++;
      usage.oldestMtime = Math.min(usage.oldestMtime, time);
    }
    if (!usage || usage.bytes > maxBytes || usage.count > maxFiles ||
        time - usage.oldestMtime > maxAgeMs || time - usage.scannedAt >= PRUNE_INTERVAL_MS) {
      prune({ protectKey: key });
    }
  }

  return { get, put, getPath, prune };
}

module.exports = { buildCacheKey, createTtsCache, speechScopeHash };
