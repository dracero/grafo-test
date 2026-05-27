const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'node_modules', 'pdf-parse', 'index.js');

try {
  if (fs.existsSync(targetFile)) {
    let content = fs.readFileSync(targetFile, 'utf8');
    
    // Replace the isDebugMode line to be always false
    const originalLine = 'let isDebugMode = !module.parent;';
    const patchedLine = 'let isDebugMode = false;';
    
    if (content.includes(originalLine)) {
      content = content.replace(originalLine, patchedLine);
      fs.writeFileSync(targetFile, content, 'utf8');
      console.log('[Patch] pdf-parse: Successfully disabled debug mode to prevent Vercel crashes.');
    } else {
      console.log('[Patch] pdf-parse: Debug mode is already patched or line not found.');
    }
  } else {
    console.warn('[Patch] pdf-parse: Target file not found, skipping patch.');
  }
} catch (error) {
  console.error('[Patch] pdf-parse: Failed to apply patch:', error);
}
