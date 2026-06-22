import { apiKeyManager } from '../src/utils/api-key-manager';

async function testAllKeys() {
  console.log('==================================================');
  console.log('🔍 INICIANDO DIAGNÓSTICO DE GOOGLE API KEYS');
  console.log('==================================================\n');

  // Re-init to load all keys
  apiKeyManager.init(true);
  const count = apiKeyManager.getGoogleKeyCount();
  console.log(`Total de claves de Google detectadas: ${count}\n`);

  for (let i = 0; i < count; i++) {
    const key = apiKeyManager.getCurrentGoogleKey();
    const maskedKey = key.substring(0, 8) + '...' + key.substring(key.length - 4);
    console.log(`Prueba clave #${i} (${maskedKey}):`);

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }]
        })
      });

      if (response.ok) {
        const json = await response.json() as any;
        console.log(`  ✅ ACTIVA (OK) - Tokens consumidos: ${json.usageMetadata?.totalTokenCount || 'N/A'}`);
      } else {
        const errText = await response.text();
        console.log(`  ❌ ERROR ${response.status}: ${errText.substring(0, 300)}...`);
      }
    } catch (err: any) {
      console.log(`  ❌ FALLO CONEXIÓN: ${err.message}`);
    }

    // Rotate to check the next key
    apiKeyManager.rotateGoogleKey();
  }
}

testAllKeys();
