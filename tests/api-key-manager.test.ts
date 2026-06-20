import { apiKeyManager } from '../src/utils/api-key-manager';

describe('ApiKeyManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should parse multiple keys from GOOGLE_API_KEYS', () => {
    process.env.GOOGLE_API_KEYS = 'key_A, key_B, key_C';
    process.env.GOOGLE_API_KEY = 'key_default';

    // We force re-initialization since it's a singleton
    // @ts-ignore
    apiKeyManager.keys = [];
    // @ts-ignore
    apiKeyManager.currentIndex = 0;
    // @ts-ignore
    apiKeyManager.init();

    expect(apiKeyManager.getKeyCount()).toBe(4); // key_A, key_B, key_C, key_default
    expect(apiKeyManager.getCurrentKey()).toBe('key_A');
  });

  it('should rotate keys sequentially', () => {
    process.env.GOOGLE_API_KEYS = 'key_A, key_B, key_C';
    // @ts-ignore
    apiKeyManager.keys = [];
    // @ts-ignore
    apiKeyManager.currentIndex = 0;
    // @ts-ignore
    apiKeyManager.init();

    expect(apiKeyManager.getCurrentKey()).toBe('key_A');
    
    // Rotate to B
    let newKey = apiKeyManager.rotateKey('key_A');
    expect(newKey).toBe('key_B');
    expect(apiKeyManager.getCurrentKey()).toBe('key_B');

    // Rotate to C
    newKey = apiKeyManager.rotateKey('key_B');
    expect(newKey).toBe('key_C');
    expect(apiKeyManager.getCurrentKey()).toBe('key_C');

    // Rotate back to A
    newKey = apiKeyManager.rotateKey('key_C');
    expect(newKey).toBe('key_A');
    expect(apiKeyManager.getCurrentKey()).toBe('key_A');
  });

  it('should not rotate key if the failed key is not the current key (concurrency safety)', () => {
    process.env.GOOGLE_API_KEYS = 'key_A, key_B, key_C';
    // @ts-ignore
    apiKeyManager.keys = [];
    // @ts-ignore
    apiKeyManager.currentIndex = 0;
    // @ts-ignore
    apiKeyManager.init();

    expect(apiKeyManager.getCurrentKey()).toBe('key_A');

    // Suppose request 1 fails with key_A and rotates the key to key_B
    apiKeyManager.rotateKey('key_A');
    expect(apiKeyManager.getCurrentKey()).toBe('key_B');

    // Suppose request 2 (which started concurrently) also fails with key_A
    // Since current key is already key_B, it should not rotate to key_C
    apiKeyManager.rotateKey('key_A');
    expect(apiKeyManager.getCurrentKey()).toBe('key_B');
  });

  it('should fallback to GOOGLE_API_KEY if GOOGLE_API_KEYS is missing', () => {
    delete process.env.GOOGLE_API_KEYS;
    process.env.GOOGLE_API_KEY = 'key_fallback';

    // @ts-ignore
    apiKeyManager.keys = [];
    // @ts-ignore
    apiKeyManager.currentIndex = 0;
    // @ts-ignore
    apiKeyManager.init();

    expect(apiKeyManager.getKeyCount()).toBe(1);
    expect(apiKeyManager.getCurrentKey()).toBe('key_fallback');

    // Rotation should do nothing since we only have 1 key
    const newKey = apiKeyManager.rotateKey('key_fallback');
    expect(newKey).toBe('key_fallback');
    expect(apiKeyManager.getCurrentKey()).toBe('key_fallback');
  });
});
