'use strict';

const { contextBridge } = require('electron');
const version = process.argv.find(arg => arg.startsWith('--inkcast-version='))?.split('=')[1];
contextBridge.exposeInMainWorld('inkcastDesktop', Object.freeze({
  isDesktop: true, version, platform: process.platform,
}));
