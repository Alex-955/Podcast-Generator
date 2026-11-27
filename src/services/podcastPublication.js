const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('./atomicWrite');
const { isValidMp3 } = require('./mp3Utils');
const { sentenceFileName } = require('./ttsService');
const { MAX_DIALOGUE_LINES } = require('./validation');

const transactionDir = (target, taskId) => path.join(target, '.tmp-publish-' + taskId);
const segment = /^sentence_([0-9]{3})\.mp3$/;

function backupDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function recoveryFailed() {
  return Object.assign(new Error('无法恢复中断的播客发布，请检查数据目录'), {
    statusCode: 503, code: 'PODCAST_RECOVERY_FAILED',
  });
}

function verifyOriginals(dir, digests) {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('微调备份目录无效');
  const names = fs.readdirSync(dir);
  if (!names.includes('meta.json') || !names.includes('full_podcast.mp3')) throw new Error('微调备份不完整');
  if (digests !== undefined && (!digests || typeof digests !== 'object' || Array.isArray(digests) ||
      Object.keys(digests).length !== names.length)) throw new Error('微调备份清单无效');
  for (const name of names) {
    const file = path.join(dir, name);
    if (!(name === 'meta.json' || name === 'full_podcast.mp3' || segment.test(name)) ||
        !fs.lstatSync(file).isFile()) throw new Error('微调备份文件无效');
    const bytes = fs.readFileSync(file);
    if (digests !== undefined) {
      if (digests[name] !== backupDigest(bytes)) throw new Error('微调备份校验失败');
    } else if (name === 'meta.json') {
      JSON.parse(bytes);
    } else if (!isValidMp3(bytes)) throw new Error('微调备份音频无效');
  }
  return names;
}

function restoreFile(originals, transaction, target, name) {
  const temp = path.join(transaction, '.restore');
  fs.rmSync(temp, { force: true });
  fs.copyFileSync(path.join(originals, name), temp, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
  fs.renameSync(temp, path.join(target, name));
}

function isSafeVersion(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value);
}

function assertPodcastVersion(currentVersion, baseVersion) {
  if ((currentVersion ?? null) !== (baseVersion ?? null)) {
    throw Object.assign(new Error('播客已更新，请打开最新剧本后再微调'), { statusCode: 409, code: 'PODCAST_VERSION_CONFLICT' });
  }
}

function readVersion(dir) {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error('播客目录无效');
  const file = path.join(dir, 'meta.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile()) throw new Error('播客元数据无效');
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw).audioVersion ?? null;
  } catch {
    throw new Error('播客元数据无效');
  }
}

function reconcileTransaction(target, dir, taskId, resolveTaskStatus) {
  const marker = path.join(dir, 'prepared');
  const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (!stat) return; // No target files were changed, or cleanup was interrupted.
  if (!stat.isFile()) throw new Error('微调事务标记无效');
  const task = resolveTaskStatus(taskId, path.basename(target));
  if (task === 'completed' || task?.status === 'completed') return;
  const originals = path.join(dir, 'originals');
  const saved = fs.readFileSync(marker, 'utf8');
  // Earlier versions used an empty marker and kept the dialogue count in the task.
  const info = saved ? JSON.parse(saved) : {
    taskId, previousVersion: readVersion(originals), dialogueCount: task?.script?.dialogue?.length,
  };
  if (info.taskId !== taskId || (saved && !isSafeVersion(info.targetVersion)) ||
      (info.previousVersion !== null && !isSafeVersion(info.previousVersion))) {
    throw new Error('微调事务版本无效');
  }
  const current = readVersion(target);
  // Metadata is renamed last. Both the committed target and a newer publication win.
  if (isSafeVersion(current) && (current === info.targetVersion || current !== info.previousVersion)) return;
  if (!Number.isSafeInteger(info.dialogueCount) || info.dialogueCount < 1 || info.dialogueCount > MAX_DIALOGUE_LINES) {
    throw new Error('微调事务句数无效');
  }
  const names = verifyOriginals(originals, info.originals);
  for (const name of names) restoreFile(originals, dir, target, name);
  for (let index = 0; index < info.dialogueCount; index++) {
    const name = sentenceFileName(index);
    if (!names.includes(name)) fs.rmSync(path.join(target, name), { force: true });
  }
}

function reconcilePendingPublications(target, resolveTaskStatus) {
  try {
    if (!fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (!entry.name.startsWith('.tmp-publish-')) continue;
      const taskId = entry.name.slice('.tmp-publish-'.length);
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('微调事务目录无效');
      const dir = path.join(target, entry.name);
      reconcileTransaction(target, dir, taskId, resolveTaskStatus);
      fs.rmSync(path.join(dir, 'prepared'), { force: true });
      fs.rmSync(dir, { recursive: true });
    }
  } catch {
    throw recoveryFailed();
  }
}

function publishEditedPodcast(target, work, baseVersion, meta, taskId, finish, resolveTaskStatus) {
  reconcilePendingPublications(target, resolveTaskStatus);
  const previousVersion = readVersion(target);
  if (previousVersion === undefined) throw new Error('目标播客元数据缺失');
  assertPodcastVersion(previousVersion, baseVersion);
  const transaction = transactionDir(target, taskId);
  fs.mkdirSync(transaction);
  const marker = path.join(transaction, 'prepared');
  const originals = path.join(transaction, 'originals');
  const replaced = [];
  const digests = {};
  let cleanup = true;
  try {
    fs.mkdirSync(originals);
    const fresh = meta.sentences.map((line, index) => {
      if (line.fileName !== sentenceFileName(index)) throw new Error('合成音频文件名无效');
      return line.fileName;
    });
    fresh.push('full_podcast.mp3');
    const obsolete = fs.readdirSync(target, { withFileTypes: true })
      .filter(entry => {
        const match = segment.exec(entry.name);
        return entry.isFile() && match && Number(match[1]) >= meta.sentences.length;
      })
      .map(entry => entry.name);
    for (const name of [...fresh, ...obsolete, 'meta.json']) {
      const original = path.join(target, name);
      const stat = fs.lstatSync(original, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile()) throw new Error('播客音频目录包含无效文件');
      const backup = path.join(originals, name);
      fs.copyFileSync(original, backup, fs.constants.COPYFILE_FICLONE);
      digests[name] = backupDigest(fs.readFileSync(backup));
    }
    for (const name of fresh) {
      fs.copyFileSync(path.join(work, name), path.join(transaction, name), fs.constants.COPYFILE_FICLONE);
    }
    atomicWrite(marker, JSON.stringify({
      taskId, previousVersion, targetVersion: meta.audioVersion, dialogueCount: meta.sentences.length, originals: digests,
    }));
    for (const name of fresh) {
      fs.renameSync(path.join(transaction, name), path.join(target, name));
      replaced.push(name);
    }
    for (const name of obsolete) {
      if (Object.hasOwn(digests, name)) {
        fs.unlinkSync(path.join(target, name));
        replaced.push(name);
      }
    }
    atomicWrite(path.join(target, 'meta.json'), JSON.stringify(meta));
    replaced.push('meta.json');
    finish();
  } catch (error) {
    cleanup = false;
    if (replaced.length) {
      try { verifyOriginals(originals, digests); }
      catch { throw recoveryFailed(); }
    }
    for (const name of replaced.reverse()) {
      if (Object.hasOwn(digests, name)) restoreFile(originals, transaction, target, name);
      else fs.unlinkSync(path.join(target, name));
    }
    fs.rmSync(marker, { force: true });
    cleanup = true;
    throw error;
  } finally {
    if (cleanup) {
      try { fs.rmSync(transaction, { recursive: true, force: true }); }
      catch { console.warn('无法清理播客发布暂存文件'); }
    }
  }
}

module.exports = { isSafeVersion, assertPodcastVersion, publishEditedPodcast, reconcilePendingPublications };
