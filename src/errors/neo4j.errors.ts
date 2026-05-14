/**
 * Neo4j Error Classes
 * 
 * Custom error classes for handling errors from Neo4j database operations.
 * Implements error handling strategy from design document.
 * 
 * Requirements: 8.3, 8.4
 */

/**
 * Custom error class for Neo4j database errors
 * 
 * Handles both recoverable errors (connection loss, timeouts) and
 * non-recoverable errors (invalid credentials, schema issues, constraint violations).
 */
export class Neo4jError extends Error {
  /**
   * Creates a new Neo4jError
   * 
   * @param message - Human-readable error message
   * @param isRecoverable - Whether the error can be retried
   * @param errorCode - Neo4j error code (e.g., "Neo.ClientError.Security.Unauthorized")
   * @param query - Optional Cypher query that caused the error
   */
  constructor(
    message: string,
    public readonly isRecoverable: boolean,
    public readonly errorCode: string,
    public readonly query?: string
  ) {
    super(message);
    this.name = 'Neo4jError';
    
    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, Neo4jError);
    }
    
    // Set the prototype explicitly for proper instanceof checks
    Object.setPrototypeOf(this, Neo4jError.prototype);
  }
  
  /**
   * Determines if a Neo4j error code represents a recoverable error
   * 
   * Recoverable errors (should retry with backoff):
   * - Connection errors (ServiceUnavailable, SessionExpired)
   * - Transaction timeout errors
   * - Transient errors
   * 
   * Non-recoverable errors:
   * - Authentication/authorization errors
   * - Syntax errors in Cypher queries
   * - Constraint violations
   * - Schema incompatibility
   * 
   * @param errorCode - Neo4j error code
   * @returns true if the error is recoverable
   */
  static isRecoverableErrorCode(errorCode: string): boolean {
    // Recoverable error patterns
    const recoverablePatterns = [
      'ServiceUnavailable',
      'SessionExpired',
      'TransientError',
      'DeadlockDetected',
      'TransactionTimeout'
    ];
    
    return recoverablePatterns.some(pattern => 
      errorCode.includes(pattern)
    );
  }
  
  /**
   * Determines if an error is related to authentication/authorization
   * 
   * @param errorCode - Neo4j error code
   * @returns true if the error is auth-related
   */
  static isAuthError(errorCode: string): boolean {
    return errorCode.includes('Security.Unauthorized') || 
           errorCode.includes('Security.Forbidden');
  }
  
  /**
   * Determines if an error is a syntax error in a Cypher query
   * 
   * @param errorCode - Neo4j error code
   * @returns true if the error is a syntax error
   */
  static isSyntaxError(errorCode: string): boolean {
    return errorCode.includes('Statement.SyntaxError') ||
           errorCode.includes('Statement.SemanticError');
  }
  
  /**
   * Determines if an error is a constraint violation
   * 
   * @param errorCode - Neo4j error code
   * @returns true if the error is a constraint violation
   */
  static isConstraintViolation(errorCode: string): boolean {
    return errorCode.includes('Schema.ConstraintValidationFailed') ||
           errorCode.includes('Schema.ConstraintViolation');
  }
  
  /**
   * Creates a Neo4jError from a Neo4j driver error
   * 
   * @param error - Error from Neo4j driver
   * @param query - Optional Cypher query that caused the error
   * @returns A new Neo4jError instance
   */
  static fromDriverError(error: any, query?: string): Neo4jError {
    const errorCode = error.code || 'Unknown';
    const message = error.message || 'Unknown Neo4j error';
    const isRecoverable = Neo4jError.isRecoverableErrorCode(errorCode);
    
    return new Neo4jError(message, isRecoverable, errorCode, query);
  }
  
  /**
   * Returns a formatted error message with all details
   */
  toDetailedString(): string {
    let details = `${this.name} [${this.errorCode}]: ${this.message}
  Recoverable: ${this.isRecoverable}`;
    
    if (this.query) {
      details += `\n  Query: ${this.query}`;
    }
    
    return details;
  }
}

/**
 * Specific error for connection failures
 */
export class Neo4jConnectionError extends Neo4jError {
  constructor(message: string, errorCode: string = 'ServiceUnavailable') {
    super(message, true, errorCode);
    this.name = 'Neo4jConnectionError';
    Object.setPrototypeOf(this, Neo4jConnectionError.prototype);
  }
}

/**
 * Specific error for authentication failures
 */
export class Neo4jAuthenticationError extends Neo4jError {
  constructor(message: string = 'Invalid Neo4j credentials') {
    super(message, false, 'Neo.ClientError.Security.Unauthorized');
    this.name = 'Neo4jAuthenticationError';
    Object.setPrototypeOf(this, Neo4jAuthenticationError.prototype);
  }
}

/**
 * Specific error for query syntax errors
 */
export class Neo4jQueryError extends Neo4jError {
  constructor(message: string, query: string) {
    super(message, false, 'Neo.ClientError.Statement.SyntaxError', query);
    this.name = 'Neo4jQueryError';
    Object.setPrototypeOf(this, Neo4jQueryError.prototype);
  }
}

/**
 * Specific error for constraint violations
 */
export class Neo4jConstraintError extends Neo4jError {
  constructor(message: string, query?: string) {
    super(message, false, 'Neo.ClientError.Schema.ConstraintValidationFailed', query);
    this.name = 'Neo4jConstraintError';
    Object.setPrototypeOf(this, Neo4jConstraintError.prototype);
  }
}

/**
 * Specific error for transaction timeouts
 */
export class Neo4jTransactionTimeoutError extends Neo4jError {
  constructor(message: string = 'Transaction timeout', query?: string) {
    super(message, true, 'Neo.TransientError.Transaction.Timeout', query);
    this.name = 'Neo4jTransactionTimeoutError';
    Object.setPrototypeOf(this, Neo4jTransactionTimeoutError.prototype);
  }
}
