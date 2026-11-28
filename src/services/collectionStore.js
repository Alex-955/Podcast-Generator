const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./atomicWrite');
const { llmSecrets } = require('./llmCredentials');
const { redactProviderDetail } = require('./providerHttp');
const { checkId, filterSensitivePath, InputError } = require('./validation');

const COLLECTION_COLORS = Object.freeze(['ink', 'vermilion', 'indigo', 'jade', 'amber', 'plum']);
const MAX_COLLECTIONS = 50;
const emptyState = () => ({ version: 1, collections: [], assignments: Object.create(null), highlights: Object.create(null) });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function redactCollectionText(value, sensitive) {
  // Also cover file: URLs, home-relative, UNC (both \\ and //, excluding http(s)/ws(s)://), and single-component absolute paths.
  return redactProviderDetail(value, sensitive)
    .replace(/\bfile:(?:\/\/)?\/?[^\s"'<>),\]，。）】》」』；、]+/giu, '***')
    .replace(/\/\/[^\s"'<>),\]，。）】》」』；、]+/gu, (match, offset, str) => {
      const before = str.slice(0, offset);
      if (/(?:^|[\s"'=(\[（【《「『；、，。]|[^\x00-\x7f])(?:https?|wss?):$/i.test(before) || /^(?:https?|wss?):$/i.test(before)) {
        return match;
      }
      return '***';
    })
    .replace(/(^|[\s"'=(\[:]|[^\x00-\x7f])(?:~[\\/]|\.{1,2}[\\/]|\\\\|\/(?!\/))[^\s"'<>),\]，。）】》」』；、]+/gu, '$1***');
}

function collectionFields(input, sensitive) {
  if (!isRecord(input)) throw new InputError('合集信息须为对象');
  const { name, description = '', color = 'ink' } = input;
  if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 30) throw new InputError('合集名称须为 1 至 30 字');
  if (description !== null && (typeof description !== 'string' || [...description.trim()].length > 120)) {
    throw new InputError('合集简介须为 120 字以内的文本');
  }
  if (!COLLECTION_COLORS.includes(color)) throw new InputError('合集颜色无效');
  for (const text of [name, description ?? '']) {
    if (redactCollectionText(text, sensitive) !== text) throw new InputError('合集信息包含凭据或本机路径');
  }
  return { name: name.trim(), description: description?.trim() ?? '', color };
}

function createCollectionStore({ dataDir, podcastsDir, adminToken, desktopSessionToken }) {
  const file = path.join(dataDir, 'collections.json');
  const sensitive = [...llmSecrets({}, {}), filterSensitivePath(dataDir), filterSensitivePath(podcastsDir), adminToken, desktopSessionToken];
  let cached, revision;

  function safeId(id) {
    checkId(id);
    if (redactCollectionText(id, sensitive) !== id) throw new InputError('资源 ID 包含敏感信息');
  }

  function checkUnique(collections, name, id) {
    if (collections.some(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) throw new InputError('合集名称重复');
  }

  function decode(raw) {
    if (raw?.version !== 1 || !Array.isArray(raw.collections) || raw.collections.length > MAX_COLLECTIONS ||
        !isRecord(raw.assignments) || !isRecord(raw.highlights)) throw new Error('合集数据格式无效');
    const state = emptyState();
    for (const { id, name, description, color, createdAt, updatedAt } of raw.collections) {
      safeId(id);
      const fields = collectionFields({ name, description, color }, sensitive);
      checkUnique(state.collections, fields.name);
      if (state.collections.some(c => c.id === id)) throw new Error('合集 ID 重复');
      for (const date of [createdAt, updatedAt]) {
        if (typeof date !== 'string' || !Number.isFinite(Date.parse(date))) throw new Error('合集时间无效');
      }
      state.collections.push({ id, ...fields, createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(updatedAt).toISOString() });
    }
    for (const [id, collectionId] of Object.entries(raw.assignments)) {
      safeId(id);
      if (state.collections.some(c => c.id === collectionId)) state.assignments[id] = collectionId;
    }
    for (const [id, highlights] of Object.entries(raw.highlights)) {
      safeId(id);
      if (!Array.isArray(highlights)) continue;
      state.highlights[id] = highlights.filter(isRecord).map(highlight => {
        const item = {};
        for (const key of ['id', 'text', 'quote', 'speaker', 'createdAt']) {
          if (typeof highlight[key] === 'string') item[key] = redactCollectionText(highlight[key], sensitive);
        }
        for (const key of ['sentenceIndex', 'startTime', 'endTime']) {
          if (Number.isFinite(highlight[key])) item[key] = highlight[key];
        }
        return item;
      }).filter(item => (typeof item.text === 'string' && item.text.trim()) || (typeof item.quote === 'string' && item.quote.trim()));
    }
    return state;
  }

  function read({ throwOnCorrupt = false } = {}) {
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    const current = stat && [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join('/');
    if (cached && current === revision) {
      if (throwOnCorrupt && cached.corrupted) {
        throw Object.assign(new Error('合集数据文件损坏，为防止覆盖原数据已中止写入'), {
          statusCode: 503, code: 'COLLECTION_DATA_CORRUPTED',
        });
      }
      return cached.state;
    }
    let state = emptyState();
    let corrupted = false;
    if (stat) {
      try {
        if (!stat.isFile()) throw new Error('合集文件类型无效');
        state = decode(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (error) {
        if (error.code) throw error;
        corrupted = true;
        console.warn('合集数据损坏，已按空合集读取');
      }
    }
    revision = current;
    cached = { state, corrupted };
    if (throwOnCorrupt && corrupted) {
      throw Object.assign(new Error('合集数据文件损坏，为防止覆盖原数据已中止写入'), {
        statusCode: 503, code: 'COLLECTION_DATA_CORRUPTED',
      });
    }
    return state;
  }

  function save(state) {
    atomicWrite(file, JSON.stringify(state));
    cached = undefined;
  }

  function find(state, id) {
    checkId(id);
    const item = state.collections.find(c => c.id === id);
    if (!item) throw Object.assign(new Error('合集不存在'), { statusCode: 404 });
    return item;
  }

  function createCollection(input, extraSensitive = []) {
    const state = read({ throwOnCorrupt: true });
    if (state.collections.length >= MAX_COLLECTIONS) throw new InputError('最多可创建 50 个合集');
    const fields = collectionFields(input, [...sensitive, ...extraSensitive]);
    checkUnique(state.collections, fields.name);
    const stamp = new Date().toISOString();
    const item = { id: 'col_' + randomUUID(), ...fields, createdAt: stamp, updatedAt: stamp };
    save({ ...state, collections: [...state.collections, item] });
    return { ...item, podcastCount: 0, highlightCount: 0 };
  }

  function updateCollection(id, input, extraSensitive = []) {
    const state = read({ throwOnCorrupt: true });
    const original = find(state, id);
    if (!isRecord(input)) throw new InputError('合集信息须为对象');
    const fields = collectionFields({ ...original, ...input }, [...sensitive, ...extraSensitive]);
    checkUnique(state.collections, fields.name, id);
    const item = { ...original, ...fields, updatedAt: new Date().toISOString() };
    save({ ...state, collections: state.collections.map(c => c.id === id ? item : c) });
    return item;
  }

  function deleteCollection(id) {
    const state = read({ throwOnCorrupt: true });
    find(state, id);
    save({ ...state, collections: state.collections.filter(c => c.id !== id),
      assignments: Object.fromEntries(Object.entries(state.assignments).filter(([, value]) => value !== id)) });
    return { id, deleted: true };
  }

  function setPodcastCollection(id, collectionId) {
    safeId(id);
    const state = read({ throwOnCorrupt: true });
    if (collectionId !== null) find(state, collectionId);
    const assignments = { ...state.assignments, [id]: collectionId };
    if (collectionId === null) delete assignments[id];
    save({ ...state, assignments });
    return { id, collectionId };
  }

  function sameInode(aPath, bPath) {
    const a = fs.lstatSync(aPath, { bigint: true, throwIfNoEntry: false });
    const b = fs.lstatSync(bPath, { bigint: true, throwIfNoEntry: false });
    return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
  }

  function probeDirCaseInsensitive(dir) {
    if (!dir || !fs.existsSync(dir)) return null;
    const id = randomUUID().replace(/-/g, '');
    const lower = path.join(dir, `.tmp-case-a-${id}`);
    const upper = path.join(dir, `.tmp-case-A-${id}`);
    let created = false;
    try {
      fs.writeFileSync(lower, '', { flag: 'wx' });
      created = true;
      return sameInode(lower, upper);
    } catch {
      return null;
    } finally {
      if (created) {
        try { fs.rmSync(lower, { force: true }); } catch {}
      }
    }
  }

  function isCaseInsensitiveFs() {
    if (podcastsDir) {
      return probeDirCaseInsensitive(podcastsDir) === true;
    }
    const probed = probeDirCaseInsensitive(dataDir);
    if (probed !== null) return probed;
    return process.platform === 'darwin' || process.platform === 'win32';
  }

  function matchingPodcastKeys(state, id) {
    if (Object.hasOwn(state.assignments, id) || Object.hasOwn(state.highlights, id)) return [id];
    const target = id.toLowerCase();
    const candidates = new Set();
    for (const key of Object.keys(state.assignments)) {
      if (key.toLowerCase() === target) candidates.add(key);
    }
    for (const key of Object.keys(state.highlights)) {
      if (key.toLowerCase() === target) candidates.add(key);
    }
    if (!candidates.size || !isCaseInsensitiveFs()) return [];
    return [...candidates];
  }

  function assertWritable() {
    read({ throwOnCorrupt: true });
  }

  function removePodcast(id) {
    const state = read({ throwOnCorrupt: true });
    const keys = matchingPodcastKeys(state, id);
    if (!keys.length) return;
    const assignments = { ...state.assignments }, highlights = { ...state.highlights };
    for (const key of keys) {
      delete assignments[key];
      delete highlights[key];
    }
    save({ ...state, assignments, highlights });
  }

  function hasPodcastData(id) {
    const state = read();
    return matchingPodcastKeys(state, id).length > 0;
  }

  function listCollections(podcasts) {
    const state = read();
    const items = state.collections.map(c => ({ ...c, podcastCount: 0, highlightCount: 0 }));
    const byId = new Map(items.map(c => [c.id, c]));
    let unassignedCount = 0;
    for (const { id } of podcasts) {
      const collection = byId.get(state.assignments[id]);
      if (collection) {
        collection.podcastCount++;
        collection.highlightCount += state.highlights[id]?.length ?? 0;
      } else unassignedCount++;
    }
    return { items, totalPodcastCount: podcasts.length, unassignedCount };
  }

  function getCollection(id, podcasts) {
    const state = read();
    const collection = find(state, id);
    const members = podcasts.filter(p => state.assignments[p.id] === id);
    const highlights = members.flatMap(p => (state.highlights[p.id] || []).map(h => ({ ...h, podcastId: p.id })));
    return { ...collection, podcastCount: members.length, highlightCount: highlights.length, podcasts: members, highlights };
  }

  return { createCollection, updateCollection, deleteCollection, setPodcastCollection, removePodcast, hasPodcastData, assertWritable, listCollections, getCollection,
    getPodcastCollectionId: id => read().assignments[id] ?? null,
    getPodcastHighlightCount: id => read().highlights[id]?.length ?? 0 };
}

module.exports = { COLLECTION_COLORS, MAX_COLLECTIONS, createCollectionStore, redactCollectionText };
