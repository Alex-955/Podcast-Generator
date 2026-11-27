'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const activeDirectories = new Map();

function locked() {
  return Object.assign(new Error('当前数据目录正被另一个运行中的 AI 妙听实例占用，请先停止该实例或使用独立的 DATA_DIR'), {
    code: 'DATA_DIR_LOCKED', statusCode: 409,
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function removeOwnedLock(file, owner) {
  const current = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (current?.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(file);
}

function tryReclaim(dir, file, claim) {
  // Announce before observing the lock. Two starters must never both validate
  // the dead inode and then unlink successive generations of the same path.
  const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) return true;
  if (!stat.isFile()) throw locked();
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const held = fs.fstatSync(fd, { bigint: true });
    if (held.dev !== stat.dev || held.ino !== stat.ino) return true;
    // Sample contenders before reading the PID. If another starter was still
    // publishing when we sampled, its unfinished record cannot be reclaimed.
    const overlap = fs.readdirSync(dir).some(name => {
      if (name === claim) return false;
      const match = /^\.server-start-([1-9]\d{0,9})-[0-9a-f-]{36}$/.exec(name);
      return match && Number(match[1]) <= 0x7fffffff && processExists(Number(match[1]));
    });
    let record;
    try {
      record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const pid = record?.pid;
    if (Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff && processExists(pid)) throw locked();
    if (overlap) return false;
    removeOwnedLock(file, held);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return true;
}

function canonicalDataDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return fs.realpathSync.native(directory);
}

async function acquireInstanceLock(directory) {
  const dir = canonicalDataDir(directory);
  // Drop our claim before retrying so simultaneous stale-lock reclaimers
  // cannot deadlock. A confirmed live owner always fails immediately.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (activeDirectories.has(dir)) throw locked();
    const release = tryAcquire(dir);
    if (release) return release;
    await delay(5 * 2 ** attempt + Math.random() * 10);
  }
  throw locked();
}

function openLockFile(dir, file, claim) {
  for (;;) {
    try {
      return fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!tryReclaim(dir, file, claim)) return;
    }
  }
}

function tryAcquire(dir) {
  const file = path.join(dir, '.server.lock');
  const claim = '.server-start-' + process.pid + '-' + randomUUID();
  const marker = path.join(dir, claim);
  fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
  let fd, owner;
  try {
    try {
      fd = openLockFile(dir, file, claim);
      if (fd === undefined) return null;
      owner = fs.fstatSync(fd, { bigint: true });
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    } finally {
      fs.rmSync(marker, { force: true });
    }
  } catch (error) {
    try {
      if (owner) removeOwnedLock(file, owner);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    throw error;
  }

  activeDirectories.set(dir, release);
  function release() {
    process.removeListener('exit', release);
    if (activeDirectories.get(dir) !== release) return;
    activeDirectories.delete(dir);
    try {
      removeOwnedLock(file, owner);
    } finally {
      fs.closeSync(fd);
    }
  }
  process.once('exit', release);
  return release;
}

// A standalone app holds a short-lived claim through synchronous recovery so
// another process cannot acquire the directory between the check and the write.
function withDataDirStartupLock(directory, ownerToken, initialize) {
  const dir = canonicalDataDir(directory);
  const active = activeDirectories.get(dir);
  if (active) {
    if (active !== ownerToken) throw locked();
    return initialize();
  }
  const release = tryAcquire(dir);
  if (!release) throw locked();
  try {
    return initialize();
  } finally {
    release();
  }
}

module.exports = { acquireInstanceLock, withDataDirStartupLock, processExists };
