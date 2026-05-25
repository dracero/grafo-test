/**
 * Error Classes Index
 * 
 * Central export point for all custom error classes in the PDF Knowledge Graph system.
 * 
 * This module provides a unified interface for importing error classes throughout
 * the application, implementing the error handling strategy defined in the design document.
 * 
 * Requirements: 8.3, 8.4
 */

// Configuration errors
export {
  ConfigurationError,
  ConfigErrorType
} from '../config/types';

// PDF processing errors
export {
  PDFProcessingError,
  PDFErrorType
} from '../models/pdf-processor.types';

// Genkit API errors
export {
  GenkitAPIError,
  RequestDetails,
  RetryConfig,
  DEFAULT_RETRY_CONFIG
} from './genkit.errors';

// Neo4j database errors
export {
  Neo4jError,
  Neo4jConnectionError,
  Neo4jAuthenticationError,
  Neo4jQueryError,
  Neo4jConstraintError,
  Neo4jTransactionTimeoutError
} from './neo4j.errors';

// Visualization errors
export {
  VisualizationError,
  VisualizationErrorType
} from './visualization.errors';

// Import classes for type checking
import { ConfigurationError as ConfigError } from '../config/types';
import { PDFProcessingError as PDFError } from '../models/pdf-processor.types';
import { GenkitAPIError as GenkitError } from './genkit.errors';
import { Neo4jError as Neo4jErr } from './neo4j.errors';
import { VisualizationError as VizError } from './visualization.errors';

/**
 * Type guard to check if an error is a custom application error
 * 
 * @param error - Error to check
 * @returns true if the error is one of our custom error types
 */
export function isApplicationError(error: any): boolean {
  return (
    error instanceof ConfigError ||
    error instanceof PDFError ||
    error instanceof GenkitError ||
    error instanceof Neo4jErr ||
    error instanceof VizError
  );
}

/**
 * Type guard to check if an error is recoverable
 * 
 * @param error - Error to check
 * @returns true if the error can be retried
 */
export function isRecoverableError(error: any): boolean {
  const errMsg = String(error?.message || error || '').toLowerCase();

  // Temporary server overload, always retry
  if (error?.status === 'UNAVAILABLE' || error?.code === 503 || errMsg.includes('503') || errMsg.includes('unavailable')) {
    return true;
  }

  // Rate limit / resource exhausted
  if (
    error?.status === 'RESOURCE_EXHAUSTED' || 
    error?.code === 429 || 
    errMsg.includes('429') || 
    errMsg.includes('resource_exhausted') || 
    errMsg.includes('resource exhausted') || 
    errMsg.includes('quota') || 
    errMsg.includes('rate limit')
  ) {
    return true;
  }

  // Genkit schema-parse error caused by truncated JSON output — retry with same params
  if (
    error?.name === 'GenkitError' &&
    typeof error?.message === 'string' &&
    (error.message.includes('parseSchema') || error.message.includes('schema') || error.message.includes('JSON'))
  ) {
    return true;
  }

  if (error instanceof ConfigError) return !error.isCritical;
  if (error instanceof PDFError)   return error.isRecoverable;
  if (error instanceof GenkitError) return error.isRecoverable;
  if (error instanceof Neo4jErr)   return error.isRecoverable;
  if (error instanceof VizError)   return error.isRecoverable();

  return false;
}

/**
 * Gets a user-friendly error message from any error
 * 
 * @param error - Error to format
 * @returns User-friendly error message
 */
export function getErrorMessage(error: any): string {
  if (isApplicationError(error)) {
    return error.message;
  }
  
  if (error instanceof Error) {
    return error.message;
  }
  
  return String(error);
}

/**
 * Gets detailed error information for logging
 * 
 * @param error - Error to format
 * @returns Detailed error information
 */
export function getDetailedErrorInfo(error: any): string {
  if (error instanceof GenkitError) {
    return error.toDetailedString();
  }
  
  if (error instanceof Neo4jErr) {
    return error.toDetailedString();
  }
  
  if (error instanceof VizError) {
    return error.toDetailedString();
  }
  
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack || 'No stack trace'}`;
  }
  
  return String(error);
}
