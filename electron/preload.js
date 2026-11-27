'use strict';

const { contextBridge } = require('electron');
const version = process.argv.find(arg => arg.startsWith('--miaoting-version='))?.split('=')[1];
contextBridge.exposeInMainWorld('aiMiaotingDesktop', Object.freeze({
  isDesktop: true, version, platform: process.platform,
}));
