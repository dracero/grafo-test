import { createLogger } from '../services/logger';
import { apiKeyManager } from './api-key-manager';

const logger = createLogger();

class GoogleRateLimiter {
  private lastRequestTime = 0;

  async throttle(): Promise<void> {
    const keysCount = apiKeyManager.getGoogleKeyCount();
    const minIntervalMs = keysCount > 1 ? 1000 : 4500;

    const now = Date.now();
    if (this.lastRequestTime === 0) {
      this.lastRequestTime = now;
      return;
    }
    const scheduledTime = Math.max(now, this.lastRequestTime + minIntervalMs);
    this.lastRequestTime = scheduledTime;
    const waitTime = scheduledTime - now;
    if (waitTime > 0) {
      logger.info('RateLimiter', `Throttling request for ${waitTime}ms to respect Google API limits...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

export const googleRateLimiter = new GoogleRateLimiter();
