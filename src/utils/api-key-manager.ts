import { createLogger } from '../services/logger';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger();

class ApiKeyManager {
  private googleKeys: string[] = [];
  private groqKeys: string[] = [];
  private currentGoogleIndex = 0;
  private currentGroqIndex = 0;

  constructor() {
    this.init(false);
  }

  /**
   * Initializes the manager by reading key lists from the .env file directly
   * as well as standard environment variables.
   */
  public init(suppressWarning = false) {
    this.googleKeys = [];
    this.groqKeys = [];

    // 1. Parse .env file directly to get all occurrences of GOOGLE_API_KEY and GROQ_API_KEY
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || !trimmed) continue;
          
          const parts = trimmed.split('=');
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, ''); // strip optional quotes
            
            if (key === 'GOOGLE_API_KEY') {
              if (val && !this.googleKeys.includes(val)) {
                this.googleKeys.push(val);
              }
            } else if (key === 'GOOGLE_API_KEYS') {
              const splitKeys = val.split(',').map(k => k.trim()).filter(k => k.length > 0);
              for (const k of splitKeys) {
                if (!this.googleKeys.includes(k)) {
                  this.googleKeys.push(k);
                }
              }
            } else if (key === 'GROQ_API_KEY') {
              if (val && !this.groqKeys.includes(val)) {
                this.groqKeys.push(val);
              }
            }
          }
        }
      }
    } catch (err: any) {
      if (!suppressWarning) {
        logger.error('ApiKeyManager', 'Error reading/parsing .env file directly', err);
      }
    }

    // 2. Fallback/extend with GOOGLE_API_KEYS (plural) if defined
    const keysEnv = typeof process !== 'undefined' && process.env ? process.env.GOOGLE_API_KEYS : undefined;
    if (keysEnv) {
      const splitKeys = keysEnv.split(',').map(k => k.trim()).filter(k => k.length > 0);
      for (const k of splitKeys) {
        if (!this.googleKeys.includes(k)) {
          this.googleKeys.push(k);
        }
      }
    }

    // 3. Ensure the primary GOOGLE_API_KEY and GROQ_API_KEY from process.env are present and tried first
    const primaryGoogleKey = typeof process !== 'undefined' && process.env && process.env.GOOGLE_API_KEY
      ? process.env.GOOGLE_API_KEY.trim()
      : undefined;
    if (primaryGoogleKey) {
      this.googleKeys = this.googleKeys.filter(k => k !== primaryGoogleKey);
      this.googleKeys.unshift(primaryGoogleKey);
    }

    const primaryGroqKey = typeof process !== 'undefined' && process.env && process.env.GROQ_API_KEY
      ? process.env.GROQ_API_KEY.trim()
      : undefined;
    if (primaryGroqKey) {
      this.groqKeys = this.groqKeys.filter(k => k !== primaryGroqKey);
      this.groqKeys.unshift(primaryGroqKey);
    }

    if (!suppressWarning) {
      logger.info('ApiKeyManager', `Loaded ${this.googleKeys.length} Google API key(s) and ${this.groqKeys.length} Groq API key(s) for rotation.`);
    }
  }

  // --- GOOGLE API KEYS ---
  getCurrentGoogleKey(): string {
    if (this.googleKeys.length === 0) {
      this.init(false);
      if (this.googleKeys.length === 0) return '';
    }
    return this.googleKeys[this.currentGoogleIndex];
  }

  rotateGoogleKey(failedKey?: string): string {
    if (this.googleKeys.length <= 1) {
      return this.getCurrentGoogleKey();
    }
    const currentKey = this.googleKeys[this.currentGoogleIndex];
    if (failedKey && currentKey !== failedKey) {
      logger.info('ApiKeyManager', 'Google key rotation requested but current key has already changed.');
      return currentKey;
    }
    const oldIndex = this.currentGoogleIndex;
    this.currentGoogleIndex = (this.currentGoogleIndex + 1) % this.googleKeys.length;
    logger.warn('ApiKeyManager', `Rotated Google API Key: Swapped index ${oldIndex} -> ${this.currentGoogleIndex} due to rate limits.`);
    return this.googleKeys[this.currentGoogleIndex];
  }

  getGoogleKeyCount(): number {
    return this.googleKeys.length;
  }

  // --- GROQ API KEYS ---
  getCurrentGroqKey(): string {
    if (this.groqKeys.length === 0) {
      this.init(false);
      if (this.groqKeys.length === 0) return '';
    }
    return this.groqKeys[this.currentGroqIndex];
  }

  rotateGroqKey(failedKey?: string): string {
    if (this.groqKeys.length <= 1) {
      return this.getCurrentGroqKey();
    }
    const currentKey = this.groqKeys[this.currentGroqIndex];
    if (failedKey && currentKey !== failedKey) {
      logger.info('ApiKeyManager', 'Groq key rotation requested but current key has already changed.');
      return currentKey;
    }
    const oldIndex = this.currentGroqIndex;
    this.currentGroqIndex = (this.currentGroqIndex + 1) % this.groqKeys.length;
    logger.warn('ApiKeyManager', `Rotated Groq API Key: Swapped index ${oldIndex} -> ${this.currentGroqIndex} due to rate/token limits.`);
    return this.groqKeys[this.currentGroqIndex];
  }

  getGroqKeyCount(): number {
    return this.groqKeys.length;
  }

  // --- BACKWARDS COMPATIBILITY ALIASES ---
  getCurrentKey(): string {
    return this.getCurrentGoogleKey();
  }

  rotateKey(failedKey?: string): string {
    return this.rotateGoogleKey(failedKey);
  }

  getKeyCount(): number {
    return this.getGoogleKeyCount();
  }
}

export const apiKeyManager = new ApiKeyManager();
