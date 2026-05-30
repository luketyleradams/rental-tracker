'use strict';
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execSync } = require('child_process');

const ROOT      = __dirname;
const PROJ_ROOT = path.dirname(ROOT);
const LOCAL   = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CURRENT = LOCAL.version || '0.0.0';

const RAW_PKG = 'https://raw.githubusercontent.com/luketyleradams/rental-tracker/main/app/package.json';
const ZIP_URL = 'https://github.com/luketyleradams/rental-tracker/archive/refs/heads/main.zip';

// Never overwrite these — user data directories
const SKIP = new Set(['data', 'node_modules', 'backups']);

function semverGt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function get(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, res => {
      // Follow redirects (GitHub zip redirects to CDN)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

function syncDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const srcEntries = new Set(fs.readdirSync(src));

  // Delete local files/dirs that no longer exist in the remote
  for (const entry of fs.readdirSync(dst)) {
    if (SKIP.has(entry)) continue;
    if (!srcEntries.has(entry)) {
      fs.rmSync(path.join(dst, entry), { recursive: true, force: true });
    }
  }

  // Copy/overwrite everything from remote
  for (const entry of srcEntries) {
    if (SKIP.has(entry)) continue;
    const srcPath = path.join(src, entry);
    const dstPath = path.join(dst, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      syncDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function cleanup(...paths) {
  for (const p of paths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
  }
}

async function main() {
  console.log('  Checking for updates...');

  // 1. Fetch remote version
  let remotePkg;
  try {
    remotePkg = JSON.parse((await get(RAW_PKG)).toString());
  } catch (e) {
    console.log(`  Could not reach update server (${e.message}). Continuing offline.`);
    process.exit(0);
  }

  const latest = remotePkg.version || '0.0.0';
  if (!semverGt(latest, CURRENT)) {
    console.log(`  Up to date (v${CURRENT}).`);
    process.exit(0);
  }

  console.log(`  Update available: v${CURRENT} → v${latest}`);
  console.log('  Downloading...');

  // 2. Download zip to temp
  const tmpZip = path.join(os.tmpdir(), `rental-tracker-${Date.now()}.zip`);
  const tmpDir = path.join(os.tmpdir(), `rental-tracker-${Date.now()}`);

  try {
    const buf = await get(ZIP_URL);
    fs.writeFileSync(tmpZip, buf);
  } catch (e) {
    console.log(`  Download failed (${e.message}). Continuing with current version.`);
    process.exit(0);
  }

  // 3. Extract zip using OS tools
  console.log('  Extracting...');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`,
        { stdio: 'pipe' }
      );
    } else {
      execSync(`unzip -q -o "${tmpZip}" -d "${tmpDir}"`, { stdio: 'pipe' });
    }
  } catch (e) {
    console.log(`  Extraction failed (${e.message}). Continuing with current version.`);
    cleanup(tmpZip, tmpDir);
    process.exit(0);
  }

  // 4. Find the extracted subfolder (rental-tracker-main/)
  const entries = fs.readdirSync(tmpDir);
  const subDir  = entries.find(e => fs.statSync(path.join(tmpDir, e)).isDirectory());
  if (!subDir) {
    console.log('  Unexpected archive structure. Continuing with current version.');
    cleanup(tmpZip, tmpDir);
    process.exit(0);
  }

  // 5. Sync app/ subfolder from zip into this directory, preserving user data
  console.log('  Installing update...');
  const appSrc = path.join(tmpDir, subDir, 'app');
  if (!fs.existsSync(appSrc)) {
    console.log('  Unexpected archive structure. Continuing with current version.');
    cleanup(tmpZip, tmpDir);
    process.exit(0);
  }
  try {
    syncDir(appSrc, ROOT);
  } catch (e) {
    console.log(`  Install failed (${e.message}). Continuing with current version.`);
    cleanup(tmpZip, tmpDir);
    process.exit(0);
  }

  // 6. Sync root-level launcher scripts so start.bat/sh/command stay up to date
  const LAUNCHERS = ['start.bat', 'start.sh', 'start.command'];
  for (const launcher of LAUNCHERS) {
    const src = path.join(tmpDir, subDir, launcher);
    const dst = path.join(PROJ_ROOT, launcher);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, dst); } catch (_) {}
    }
  }

  cleanup(tmpZip, tmpDir);
  console.log(`  Updated to v${latest}!`);
  console.log('');
  // Exit code 42 = updated; start scripts will re-run npm install
  process.exit(42);
}

main().catch(e => {
  console.log(`  Updater error: ${e.message}. Continuing with current version.`);
  process.exit(0);
});
