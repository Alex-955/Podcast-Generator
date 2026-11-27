const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./atomicWrite');
const { sentenceFileName } = require('./ttsService');

const transactionDir = (target, taskId) => path.join(target, '.tmp-publish-' + taskId);
const segment = /^sentence_[0-9]{3}\.mp3$/;

function restoreFile(originals, transaction, target, name) {
  const temp = path.join(transaction, '.restore');
  fs.rmSync(temp, { force: true });
  fs.copyFileSync(path.join(originals, name), temp, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
  fs.renameSync(temp, path.join(target, name));
}

// A process can stop between two file renames. The completed task record
// commits the transaction. Until then a prepared backup remains authoritative.
function recoverPublication(target, task) {
  if (!fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) return;
  const dir = transactionDir(target, task.id);
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  const marker = path.join(dir, 'prepared');
  if (task.status !== 'completed' && fs.lstatSync(marker, { throwIfNoEntry: false })?.isFile()) {
    const originals = path.join(dir, 'originals');
    if (!fs.lstatSync(originals).isDirectory()) throw new Error('微调备份目录无效');
    const names = fs.readdirSync(originals);
    if (!names.includes('meta.json') || !names.includes('full_podcast.mp3') || names.some(name =>
      !(name === 'meta.json' || name === 'full_podcast.mp3' || segment.test(name)) ||
      !fs.lstatSync(path.join(originals, name)).isFile())) throw new Error('微调备份不完整');
    for (const name of names) {
      // Preserve originals so recovery itself can be interrupted and retried.
      restoreFile(originals, dir, target, name);
    }
    for (const index of task.script.dialogue.keys()) {
      const name = sentenceFileName(index);
      if (!names.includes(name)) fs.rmSync(path.join(target, name), { force: true });
    }
    fs.unlinkSync(marker);
  }
  fs.rmSync(dir, { recursive: true });
}

// All renames are on the podcast volume. Keep the old files until both
// metadata and the completed task record have been written successfully.
function publishEditedPodcast(target, work, previous, meta, taskId, finish) {
  const transaction = transactionDir(target, taskId);
  fs.mkdirSync(transaction);
  const marker = path.join(transaction, 'prepared');
  const originals = path.join(transaction, 'originals');
  const replaced = [];
  const existed = new Set();
  let cleanup = true;
  try {
    fs.mkdirSync(originals);
    const fresh = meta.sentences.map((line, index) => {
      if (line.fileName !== sentenceFileName(index)) throw new Error('合成音频文件名无效');
      return line.fileName;
    });
    fresh.push('full_podcast.mp3');
    const obsolete = (previous.sentences || []).flatMap((line, index) =>
      index >= meta.sentences.length && line.fileName === sentenceFileName(index) ? [line.fileName] : []);
    for (const name of [...fresh, ...obsolete, 'meta.json']) {
      const original = path.join(target, name);
      const stat = fs.lstatSync(original, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile()) throw new Error('播客音频目录包含无效文件');
      fs.copyFileSync(original, path.join(originals, name), fs.constants.COPYFILE_FICLONE);
      existed.add(name);
    }
    for (const name of fresh) {
      fs.copyFileSync(path.join(work, name), path.join(transaction, name), fs.constants.COPYFILE_FICLONE);
    }
    atomicWrite(marker, '');
    for (const name of fresh) {
      fs.renameSync(path.join(transaction, name), path.join(target, name));
      replaced.push(name);
    }
    for (const name of obsolete) {
      if (existed.has(name)) {
        fs.unlinkSync(path.join(target, name));
        replaced.push(name);
      }
    }
    atomicWrite(path.join(target, 'meta.json'), JSON.stringify(meta));
    replaced.push('meta.json');
    finish();
  } catch (error) {
    cleanup = false;
    for (const name of replaced.reverse()) {
      if (existed.has(name)) restoreFile(originals, transaction, target, name);
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

module.exports = { publishEditedPodcast, recoverPublication };
