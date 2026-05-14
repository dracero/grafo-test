/**
 * Utility functions for retry logic with exponential backoff
 * 
 * Requirements: 8.3
 */

import { isRecoverableError } from '../errors';
import { Logger } from '../types/logging';

export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number;
  
  /** Initial delay in milliseconds before first retry */
  initialDelayMs: number;
  
  /** Maximum delay in milliseconds between retries */
  maxDelayMs: number;
  
  /** Multiplier for exponential backoff */
  backoffMultiplier?: number;
  
  /** Logger to use for retry warnings */
  logger?: Logger;
  
  /** Component name for logging */
  component?: string;
  
  /** Operation name for logging */
  operationName?: string;
}

const DEFAULT_OPTIONS: Partial<RetryOptions> = {
  backoffMultiplier: 2,
  component: 'RetryUtility',
  operationName: 'Operation'
};

/**
 * Executes a function with exponential backoff retry logic.
 * Only retries if the error is considered recoverable.
 * 
 * @param operation The async function to execute
 * @param options Configuration for retry behavior
 * @returns The result of the operation
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const fullOptions = { ...DEFAULT_OPTIONS, ...options };
  const { maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier, logger, component, operationName } = fullOptions as Required<RetryOptions>;

  let attempt = 0;
  let currentDelay = initialDelayMs;

  while (true) {
    try {
      return await operation();
    } catch (error: any) {
      attempt++;

      // Check if we've exhausted all retries or if the error is not recoverable
      const isRecoverable = isRecoverableError(error);
      
      if (attempt > maxRetries || !isRecoverable) {
        if (logger) {
          logger.error(
            component,
            `${operationName} failed after ${attempt} attempts (Recoverable: ${isRecoverable})`,
            error,
            { attempt, maxRetries, isRecoverable }
          );
        }
        throw error;
      }

      // Log the warning and wait before retrying
      if (logger) {
        logger.warn(
          component,
          `${operationName} failed, retrying in ${currentDelay}ms (Attempt ${attempt}/${maxRetries})`,
          { error: error.message || String(error) }
        );
      }

      await new Promise(resolve => setTimeout(resolve, currentDelay));

      // Calculate next delay
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs);
    }
  }
}
