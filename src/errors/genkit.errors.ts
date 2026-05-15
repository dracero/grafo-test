/**
 * Genkit API Error Classes
 * 
 * Custom error classes for handling errors from Google Genkit API.
 * Implements error handling strategy from design document.
 * 
 * Requirements: 8.3, 8.4
 */

/**
 * Details about the API request that failed
 */
export interface RequestDetails {
  /** API endpoint that was called */
  endpoint: string;
  
  /** Length of text being processed (optional for non-text requests) */
  textLength?: number;
  
  /** Timestamp when the request was made */
  timestamp: Date;

  /** Additional details specific to the request type */
  additionalInfo?: Record<string, any>;
}

/**
 * Custom error class for Genkit API errors
 * 
 * Handles both recoverable errors (rate limiting, network issues) and
 * non-recoverable errors (invalid API key, malformed requests).
 */
export class GenkitAPIError extends Error {
  /**
   * Creates a new GenkitAPIError
   * 
   * @param message - Human-readable error message
   * @param statusCode - HTTP status code from the API response
   * @param isRecoverable - Whether the error can be retried
   * @param requestDetails - Details about the failed request
   */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly isRecoverable: boolean,
    public readonly requestDetails: RequestDetails
  ) {
    super(message);
    this.name = 'GenkitAPIError';
    
    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GenkitAPIError);
    }
    
    // Set the prototype explicitly for proper instanceof checks
    Object.setPrototypeOf(this, GenkitAPIError.prototype);
  }
  
  /**
   * Determines if an HTTP status code represents a recoverable error
   * 
   * Recoverable errors (should retry with backoff):
   * - 429: Rate limiting
   * - 500, 502, 503, 504: Server errors and timeouts
   * 
   * Non-recoverable errors:
   * - 400: Bad request (malformed)
   * - 401: Unauthorized (invalid API key)
   * - 403: Forbidden (quota exceeded)
   * 
   * @param statusCode - HTTP status code
   * @returns true if the error is recoverable
   */
  static isRecoverableStatusCode(statusCode: number): boolean {
    const recoverableCodes = [429, 500, 502, 503, 504];
    return recoverableCodes.includes(statusCode);
  }
  
  /**
   * Creates a GenkitAPIError from an HTTP response
   * 
   * @param statusCode - HTTP status code
   * @param message - Error message
   * @param requestDetails - Details about the request
   * @returns A new GenkitAPIError instance
   */
  static fromResponse(
    statusCode: number,
    message: string,
    requestDetails: RequestDetails
  ): GenkitAPIError {
    const isRecoverable = GenkitAPIError.isRecoverableStatusCode(statusCode);
    return new GenkitAPIError(message, statusCode, isRecoverable, requestDetails);
  }
  
  /**
   * Returns a formatted error message with all details
   */
  toDetailedString(): string {
    return `${this.name} [${this.statusCode}]: ${this.message}
  Endpoint: ${this.requestDetails.endpoint}
  Text Length: ${this.requestDetails.textLength ?? 'N/A'}
  Additional Info: ${this.requestDetails.additionalInfo ? JSON.stringify(this.requestDetails.additionalInfo) : 'None'}
  Timestamp: ${this.requestDetails.timestamp.toISOString()}
  Recoverable: ${this.isRecoverable}`;
  }
}

/**
 * Retry configuration for handling recoverable errors
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  
  /** Initial delay in milliseconds before first retry */
  initialDelayMs: number;
  
  /** Maximum delay in milliseconds between retries */
  maxDelayMs: number;
  
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
}

/**
 * Default retry configuration for Genkit API errors
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2
};
