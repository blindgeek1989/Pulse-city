#!/usr/bin/env node
/**
 * Downloads the Babylon.js Draco decoder files from the Babylon CDN into
 * public/draco/ so they can be served locally in production builds.
 *
 * Run before `vite build` in CI via `npm run build:ci`.
 * Local dev uses the CDN directly (see main.js dracoBase logic) so this
 * script does not need to run during local development.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRACO_DIR = path.join(__dirname, '..', 'public', 'draco');

const FILES = [
  'draco_wasm_wrapper_gltf.js',
  'draco_decoder_gltf.wasm',
  'draco_decoder_gltf.js',
];

const CDN = 'https://cdn.babylonjs.com/';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.destroy();
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      pipeline(res, file).then(resolve).catch(reject);
    }).on('error', reject);
  });
}

async function main() {
  await mkdir(DRACO_DIR, { recursive: true });
  for (const file of FILES) {
    const url  = CDN + file;
    const dest = path.join(DRACO_DIR, file);
    process.stdout.write(`  Downloading ${file} … `);
    await download(url, dest);
    console.log('done');
  }
  console.log(`Draco decoder ready in ${path.relative(process.cwd(), DRACO_DIR)}`);
}

main().catch((err) => {
  console.error('\nfetch-draco failed:', err.message);
  process.exit(1);
});
