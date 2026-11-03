'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');

function platformFile() {
  return `ter-fs.${process.platform}-${process.arch}.node`;
}

/**
 * Resolves the binary, accounting for electron-builder's asar packaging where
 * native modules live in app.asar.unpacked next to app.asar.
 */
function resolveBinary() {
  const name = platformFile();
  const candidates = [path.join(__dirname, name)];
  if (__dirname.includes(`app.asar${path.sep}`)) {
    candidates.push(path.join(__dirname.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), name));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `The native filesystem module (${name}) is missing. Run "npm run build:native" before starting Ter Editor.`,
  );
}

module.exports = require(resolveBinary());
