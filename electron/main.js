'use strict';

const { app, BrowserWindow, Menu, dialog, screen, shell, session, protocol } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MIN_WIDTH, MIN_HEIGHT, loadWindowState, saveWindowState } = require('./windowState');
const { DESKTOP_ORIGIN, classify, guardNavigation, allowDownload } = require('./navigationGuard');
const { importLegacyPodcasts } = require('./migration');

protocol.registerSchemesAsPrivileged([{ scheme: 'aimiaoting', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
} }]);

async function proxyDesktopRequest(request, port, token) {
  if (classify(request.url) !== 'local') return new Response(null, { status: 403 });
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'origin', 'referer']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  headers.set('x-desktop-session', token);
  headers.set('accept-encoding', 'identity');
  const response = await fetch('http://127.0.0.1:' + port + url.pathname + url.search, {
    method: request.method, headers, body: request.body, duplex: 'half', redirect: 'manual', signal: request.signal,
  });
  const resultHeaders = new Headers(response.headers);
  for (const name of ['connection', 'keep-alive', 'transfer-encoding']) resultHeaders.delete(name);
  resultHeaders.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return new Response(response.body, { headers: resultHeaders, status: response.status });
}

try {
  app.setName('AI 妙听');
  if (process.env.AI_MIAOTING_USER_DATA) {
    const directory = path.resolve(process.env.AI_MIAOTING_USER_DATA);
    fs.mkdirSync(directory, { recursive: true });
    app.setPath('userData', directory);
  }
  if (app.requestSingleInstanceLock()) runDesktop();
  else app.quit();
} catch {
  dialog.showErrorBox('AI 妙听无法启动', '无法访问用户数据目录，请检查该目录是否可写。');
  app.exit(1);
}

function runDesktop() {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const podcastsDir = path.join(userData, 'podcasts');
  const repo = 'https://github.com/Alex-955/Podcast-Generator';
  const mac = process.platform === 'darwin';
  let exitCode = 0;
  let mainWindow, handle, origin, starting, quitting, importing, copyInProgress;

  function focus() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (origin && !quitting) createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function createWindow() {
    const areas = [screen.getPrimaryDisplay().workArea, ...screen.getAllDisplays().map(display => display.workArea)];
    const bounds = loadWindowState(userData, areas);
    const win = new BrowserWindow({
      ...bounds, minWidth: Math.min(MIN_WIDTH, bounds.width), minHeight: Math.min(MIN_HEIGHT, bounds.height),
      title: 'AI 妙听', backgroundColor: '#F5F2EB',
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        preload: path.join(__dirname, 'preload.js'), additionalArguments: ['--miaoting-version=' + app.getVersion()],
      },
    });
    mainWindow = win;
    guardNavigation(win.webContents, origin, url => shell.openExternal(url));
    win.on('close', () => rememberWindow(win));
    win.on('closed', () => { mainWindow = null; });
    win.loadURL(origin + '/').catch(() => {
      if (!quitting && !win.isDestroyed()) {
        dialog.showErrorBox('AI 妙听', '工作台加载失败，请退出后重新打开。');
        app.quit();
      }
    });
  }

  function rememberWindow(win) {
    try { saveWindowState(userData, win.getNormalBounds()); }
    catch { /* Geometry is optional on read-only storage. */ }
  }

  async function importFromFolder() {
    const choice = await dialog.showOpenDialog({ title: '导入旧版便携播客', properties: ['openDirectory'] });
    if (choice.canceled || quitting) return;
    copyInProgress = importLegacyPodcasts(choice.filePaths[0], podcastsDir);
    const { importedCount, skippedCount, invalidCount } = await copyInProgress;
    if (quitting) return;
    mainWindow?.reload();
    await dialog.showMessageBox({ message: '导入完成', detail: `已导入 ${importedCount} 期，同名跳过 ${skippedCount} 期，无效跳过 ${invalidCount} 项。` });
  }

  function setMenu() {
    const folders = [['打开数据目录', dataDir], ['打开播客音频目录', podcastsDir]];
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(mac ? [{ role: 'appMenu' }] : []),
      { label: '文件', submenu: [{ role: mac ? 'close' : 'quit' }] },
      { label: '编辑', role: 'editMenu' },
      { label: '数据', submenu: [
        ...folders.map(([label, dir]) => ({ label, click: async () => {
          if (await shell.openPath(dir)) dialog.showErrorBox('AI 妙听', '无法打开所选文件夹。');
        } })),
        { type: 'separator' },
        { label: '导入旧版便携播客…', click: () => {
          importing ??= importFromFolder().catch(() => {
            if (!quitting) dialog.showErrorBox('导入未完成', '请选择便携版根目录或 podcasts 文件夹，并检查读取权限与剩余空间。已导入的播客可保留。');
          }).finally(() => { importing = null; copyInProgress = null; });
        } },
      ] },
      { label: '窗口', role: 'windowMenu' },
      { label: '帮助', submenu: [
        { label: 'GitHub 仓库', click: () => shell.openExternal(repo) },
        { label: '首次打开与系统安全提示', click: () => shell.openExternal(repo + '#first-launch') },
      ] },
    ]));
  }

  app.on('second-instance', focus);
  app.on('activate', focus);
  app.on('window-all-closed', () => { if (!mac) app.quit(); });
  app.on('before-quit', event => {
    event.preventDefault();
    quitting ??= Promise.resolve().then(async () => {
      await starting;
      await copyInProgress?.catch(() => {});
      await handle?.close({ timeoutMs: 5000 });
    }).catch(() => {
      exitCode = 1;
      dialog.showErrorBox('AI 妙听', '服务未能完整关闭，请重新打开检查任务状态。');
    }).finally(() => {
      if (mainWindow && !mainWindow.isDestroyed()) rememberWindow(mainWindow);
      if (app.isReady()) session.defaultSession.flushStorageData();
      // The native macOS termination request may still be pending. Re-entering
      // app.quit() here can close the last window yet leave the process alive.
      app.exit(exitCode);
    });
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit());

  starting = app.whenReady().then(async () => {
    if (quitting) return;
    fs.mkdirSync(podcastsDir, { recursive: true });
    const { startServer, DEFAULT_PORT } = require('../server');
    const desktopSessionToken = randomBytes(32).toString('hex');
    handle = await startServer({ dataDir, podcastsDir, desktopSessionToken, host: '127.0.0.1',
      port: DEFAULT_PORT, allowPortFallback: true, publicDir: path.join(__dirname, '..', 'public') });
    if (quitting) return;
    origin = DESKTOP_ORIGIN;
    protocol.handle('aimiaoting', request => proxyDesktopRequest(request, handle.port, desktopSessionToken));
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    session.defaultSession.on('will-download', (event, item, source) => {
      if (source !== mainWindow?.webContents || !allowDownload(item.getURLChain(), origin)) event.preventDefault();
    });
    setMenu();
    createWindow();
  }).catch(error => {
    exitCode = 1;
    dialog.showErrorBox('AI 妙听无法启动', error.code === 'DATA_DIR_LOCKED'
      ? '数据目录正在使用中。请先退出占用该目录的实例。' : '请检查数据目录权限及本机网络是否可用。');
    app.quit();
  });
}
