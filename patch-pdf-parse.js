const fs = require('fs');
const path = require('path');

// ── Patch 1: pdf-parse debug mode ───────────────────────────────────────────
// pdf-parse has a debug mode that runs when module.parent is falsy (ESM env).
// This causes it to try loading a test PDF that doesn't exist → ENOENT crash.
(function patchPdfParse() {
  const targetFile = path.join(__dirname, 'node_modules', 'pdf-parse', 'index.js');
  try {
    if (!fs.existsSync(targetFile)) {
      console.warn('[Patch] pdf-parse: File not found, skipping.');
      return;
    }
    let content = fs.readFileSync(targetFile, 'utf8');
    if (content.includes('let isDebugMode = !module.parent;')) {
      content = content.replace('let isDebugMode = !module.parent;', 'let isDebugMode = false;');
      fs.writeFileSync(targetFile, content, 'utf8');
      console.log('[Patch] pdf-parse: Disabled debug mode ✓');
    } else {
      console.log('[Patch] pdf-parse: Already patched ✓');
    }
  } catch (e) {
    console.error('[Patch] pdf-parse: Failed:', e.message);
  }
})();

// ── Patch 2: @google/adk ERR_REQUIRE_ESM ────────────────────────────────────
// @google/adk CJS build uses require('lodash-es') which is ESM-only → crash.
// We replace it with require('lodash') which is the CJS-compatible equivalent.
(function patchAdk() {
  const targetFile = path.join(__dirname, 'node_modules', '@google', 'adk', 'dist', 'cjs', 'agents', 'functions.js');
  try {
    if (!fs.existsSync(targetFile)) {
      console.warn('[Patch] @google/adk: File not found, skipping.');
      return;
    }
    let content = fs.readFileSync(targetFile, 'utf8');
    if (content.includes('require("lodash-es")')) {
      content = content.replace('require("lodash-es")', 'require("lodash")');
      fs.writeFileSync(targetFile, content, 'utf8');
      console.log('[Patch] @google/adk: Replaced lodash-es with lodash ✓');
    } else {
      console.log('[Patch] @google/adk: Already patched ✓');
    }
  } catch (e) {
    console.error('[Patch] @google/adk: Failed:', e.message);
  }
})();
