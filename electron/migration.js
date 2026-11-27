'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { redactProviderDetail } = require('../src/services/providerHttp');

async function statIfPresent(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function findPodcasts(selected) {
  if (!(await statIfPresent(selected))?.isDirectory()) throw new Error('请选择普通文件夹');
  const root = await fs.realpath(selected);
  const pub = path.join(root, 'public');
  const podcasts = path.join(pub, 'podcasts');
  if ((await statIfPresent(pub))?.isDirectory() && (await statIfPresent(podcasts))?.isDirectory()) return podcasts;
  if (path.basename(root).toLowerCase() === 'podcasts') return root;
  throw new Error('请选择旧版便携根目录或 podcasts 文件夹');
}

function nested(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

async function realDestination(dir) {
  const stat = await statIfPresent(dir);
  if (stat) {
    if (!stat.isDirectory()) throw new Error('目标必须是普通文件夹');
    return fs.realpath(dir);
  }
  return path.join(await realDestination(path.dirname(dir)), path.basename(dir));
}

// Older metadata may carry provider settings and local source paths. Strip
// private fields and their echoed values while preserving safe metadata.
function importMetadata(bytes) {
  const secrets = [];
  let changed = false;
  const privateField = /(?:api[_-]?key|access[_-]?key|app[_-]?id|secret|token|password|authorization|base[_-]?url|endpoint|file[_-]?path)$/i;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  let meta;
  try {
    meta = JSON.parse(bytes, (key, value) => {
      if (!privateField.test(key)) return value;
      changed = true;
      if (typeof value === 'string' && value.trim()) secrets.push(value);
      return undefined;
    });
  } catch { return null; }
  if (!record(meta) || ('sentences' in meta && !(Array.isArray(meta.sentences) && meta.sentences.every(record)))) return null;
  const clean = JSON.stringify(meta, (key, value) => {
    if (typeof value !== 'string') return value;
    if (['audioUrl', 'fullAudioUrl'].includes(key) && /^\/podcasts\/[\w-]+\/(?:full_podcast|sentence_[\w-]+)\.mp3$/.test(value)) return value;
    const safe = redactProviderDetail(value, secrets);
    if (value !== safe) changed = true;
    return safe;
  });
  return changed ? clean : bytes;
}

async function stagePodcast(source, stage) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() &&
    /^(?:meta\.json|full_podcast\.mp3|sentence_[\w-]+\.mp3)$/.test(entry.name));
  if (!['meta.json', 'full_podcast.mp3'].every(name => files.some(entry => entry.name === name))) return false;
  for (const { name } of files) {
    const file = await fs.open(path.join(source, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (name === 'full_podcast.mp3' && !stat.size)) return false;
      const dest = path.join(stage, name);
      if (name === 'meta.json') {
        const bytes = importMetadata(await file.readFile('utf8'));
        if (bytes === null) return false;
        await fs.writeFile(dest, bytes, { flag: 'wx' });
      } else {
        const output = createWriteStream(dest, { flags: 'wx' });
        await pipeline(file.createReadStream(), output);
      }
    } finally { await file.close(); }
  }
  return true;
}

async function importLegacyPodcasts(sourceDir, targetPodcastsDir) {
  const sourcePodcastsDir = await findPodcasts(path.resolve(sourceDir));
  const target = await realDestination(path.resolve(targetPodcastsDir));
  if (nested(await fs.realpath(sourceDir), target) || nested(target, sourcePodcastsDir)) throw new Error('源目录与目标目录不能重叠');
  await fs.mkdir(target, { recursive: true });
  const result = { sourcePodcastsDir, importedCount: 0, skippedCount: 0, invalidCount: 0 };
  for (const entry of await fs.readdir(sourcePodcastsDir, { withFileTypes: true })) {
    if (entry.isFile()) continue;
    if (!entry.isDirectory() || !/^[\w-]+$/.test(entry.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(entry.name)) {
      result.invalidCount++;
      continue;
    }
    const dest = path.join(target, entry.name);
    if (await statIfPresent(dest)) { result.skippedCount++; continue; }
    const stage = await fs.mkdtemp(path.join(target, '.import-'));
    try {
      if (!await stagePodcast(path.join(sourcePodcastsDir, entry.name), stage)) result.invalidCount++;
      else if (await statIfPresent(dest)) result.skippedCount++;
      else {
        await fs.rename(stage, dest);
        result.importedCount++;
      }
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code) && await statIfPresent(dest)) result.skippedCount++;
      else if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) result.invalidCount++;
      else throw error;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  return result;
}

module.exports = { importLegacyPodcasts };
