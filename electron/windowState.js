'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../src/services/atomicWrite');

const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

function fitWindow(saved, areas) {
  const width = Number.isSafeInteger(saved?.width) ? saved.width : 1280;
  const height = Number.isSafeInteger(saved?.height) ? saved.height : 840;
  const positioned = Number.isSafeInteger(saved?.x) && Number.isSafeInteger(saved?.y);
  let area = areas[0], largest = 0;
  if (positioned) {
    for (const display of areas) {
      const overlap = Math.max(0, Math.min(saved.x + width, display.x + display.width) - Math.max(saved.x, display.x))
        * Math.max(0, Math.min(saved.y + height, display.y + display.height) - Math.max(saved.y, display.y));
      if (overlap > largest) { largest = overlap; area = display; }
    }
  }
  const w = Math.min(area.width, Math.max(width, MIN_WIDTH));
  const h = Math.min(area.height, Math.max(height, MIN_HEIGHT));
  return {
    width: w, height: h,
    x: largest ? clamp(saved.x, area.x, area.x + area.width - w) : area.x + Math.floor((area.width - w) / 2),
    y: largest ? clamp(saved.y, area.y, area.y + area.height - h) : area.y + Math.floor((area.height - h) / 2),
  };
}

function loadWindowState(userData, areas) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(userData, 'window-state.json'), 'utf8')); }
  catch { /* First launch or interrupted state from a previous version. */ }
  return fitWindow(saved, areas);
}

function saveWindowState(userData, bounds) {
  atomicWrite(path.join(userData, 'window-state.json'), JSON.stringify(bounds));
}

module.exports = { MIN_WIDTH, MIN_HEIGHT, fitWindow, loadWindowState, saveWindowState };
