import { createLogger } from '../services/logger';

const logger = createLogger();

class ApiKeyManager {
  private keys: string[] = [];
  private currentIndex = 0;

  constructor() {
    this.init(true);
  }

  /**
   * Initializes the manager by reading key lists from env variables.
   * Runs synchronously on module load.
   */
  public init(suppressWarning = false) {
    // If we are in client side, process.env might not be populated in same way.
    // In Astro, server-side process.env is fully available.
    const keysEnv = typeof process !== 'undefined' && process.env ? process.env.GOOGLE_API_KEYS : undefined;
    if (keysEnv) {
      this.keys = keysEnv
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0);
    }

    const singleKey = typeof process !== 'undefined' && process.env ? process.env.GOOGLE_API_KEY : undefined;
    if (singleKey) {
      const trimmedSingle = singleKey.trim();
      if (trimmedSingle && !this.keys.includes(trimmedSingle)) {
        this.keys.push(trimmedSingle);
      }
    }

    if (this.keys.length === 0) {
      if (!suppressWarning) {
        logger.warn('ApiKeyManager', 'No Google API keys found in GOOGLE_API_KEYS or GOOGLE_API_KEY env vars.');
      }
    } else {
      logger.info('ApiKeyManager', `Loaded ${this.keys.length} Google API key(s) for rotation.`);
    }
  }

  /**
   * Gets the currently active API key.
   */
  getCurrentKey(): string {
    if (this.keys.length === 0) {
      // Re-try loading in case env variables were loaded later (e.g. dotenv config lag)
      this.init(false);
      if (this.keys.length === 0) {
        return (typeof process !== 'undefined' && process.env ? process.env.GOOGLE_API_KEY : undefined) || '';
      }
    }
    return this.keys[this.currentIndex];
  }

  /**
   * Rotates to the next key. If failedKey is provided, only rotates if the currently
   * active key matches the failedKey (concurrency-safe guard).
   * 
   * @param failedKey - The key that triggered the failure
   * @returns The newly selected active key
   */
  rotateKey(failedKey?: string): string {
    if (this.keys.length <= 1) {
      return this.getCurrentKey();
    }

    const currentKey = this.keys[this.currentIndex];

    // Concurrency safety check: if current key is already different from the failed key,
    // another request already did the rotation for this key, so we do not rotate again.
    if (failedKey && currentKey !== failedKey) {
      logger.info('ApiKeyManager', 'Key rotation requested but current key has already changed. Skipping double rotation.');
      return currentKey;
    }

    const oldIndex = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    logger.warn('ApiKeyManager', `Rotated API Key: Swapped index ${oldIndex} -> ${this.currentIndex} due to rate limits or 503 errors.`);
    return this.keys[this.currentIndex];
  }

  /**
   * Returns the count of loaded keys.
   */
  getKeyCount(): number {
    return this.keys.length;
  }
}

export const apiKeyManager = new ApiKeyManager();
