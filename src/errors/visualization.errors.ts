/**
 * Visualization Error Classes
 * 
 * Custom error classes for handling errors in the visualization service.
 * Implements error handling strategy from design document.
 * 
 * Requirements: 8.3, 8.4
 */

/**
 * Types of visualization errors
 */
export enum VisualizationErrorType {
  /** Invalid filter parameters provided */
  INVALID_FILTER = 'INVALID_FILTER',
  
  /** Requested node does not exist in the graph */
  NODE_NOT_FOUND = 'NODE_NOT_FOUND',
  
  /** Query to Neo4j timed out */
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',
  
  /** Data format is incompatible with visualization library */
  DATA_FORMAT_ERROR = 'DATA_FORMAT_ERROR',
  
  /** Too many nodes requested, exceeds limit */
  TOO_MANY_NODES = 'TOO_MANY_NODES',
  
  /** Invalid entity type specified */
  INVALID_ENTITY_TYPE = 'INVALID_ENTITY_TYPE',
  
  /** Invalid document name specified */
  INVALID_DOCUMENT = 'INVALID_DOCUMENT'
}

/**
 * Custom error class for visualization service errors
 * 
 * Handles errors that occur during graph visualization operations,
 * including invalid filters, missing nodes, and data format issues.
 */
export class VisualizationError extends Error {
  /**
   * Creates a new VisualizationError
   * 
   * @param message - Human-readable error message
   * @param errorType - Type of visualization error
   * @param context - Optional additional context about the error
   */
  constructor(
    message: string,
    public readonly errorType: VisualizationErrorType,
    public readonly context?: any
  ) {
    super(message);
    this.name = 'VisualizationError';
    
    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, VisualizationError);
    }
    
    // Set the prototype explicitly for proper instanceof checks
    Object.setPrototypeOf(this, VisualizationError.prototype);
  }
  
  /**
   * Determines if the error is recoverable
   * 
   * Recoverable errors:
   * - QUERY_TIMEOUT: Can retry with reduced node limit
   * 
   * Non-recoverable errors:
   * - INVALID_FILTER: Client must fix the filter
   * - NODE_NOT_FOUND: Node doesn't exist
   * - DATA_FORMAT_ERROR: Data structure issue
   * - TOO_MANY_NODES: Client must reduce request size
   * - INVALID_ENTITY_TYPE: Client must use valid type
   * - INVALID_DOCUMENT: Document doesn't exist
   * 
   * @returns true if the error is recoverable
   */
  isRecoverable(): boolean {
    return this.errorType === VisualizationErrorType.QUERY_TIMEOUT;
  }
  
  /**
   * Creates a VisualizationError for invalid filter
   * 
   * @param filterDetails - Details about the invalid filter
   * @returns A new VisualizationError instance
   */
  static invalidFilter(filterDetails: any): VisualizationError {
    return new VisualizationError(
      'Invalid filter parameters provided',
      VisualizationErrorType.INVALID_FILTER,
      filterDetails
    );
  }
  
  /**
   * Creates a VisualizationError for node not found
   * 
   * @param nodeId - ID of the node that was not found
   * @returns A new VisualizationError instance
   */
  static nodeNotFound(nodeId: string): VisualizationError {
    return new VisualizationError(
      `Node with ID '${nodeId}' not found in the graph`,
      VisualizationErrorType.NODE_NOT_FOUND,
      { nodeId }
    );
  }
  
  /**
   * Creates a VisualizationError for query timeout
   * 
   * @param timeoutMs - Timeout duration in milliseconds
   * @param nodeCount - Number of nodes that were being queried
   * @returns A new VisualizationError instance
   */
  static queryTimeout(timeoutMs: number, nodeCount?: number): VisualizationError {
    return new VisualizationError(
      `Query timed out after ${timeoutMs}ms`,
      VisualizationErrorType.QUERY_TIMEOUT,
      { timeoutMs, nodeCount }
    );
  }
  
  /**
   * Creates a VisualizationError for data format error
   * 
   * @param details - Details about the format error
   * @returns A new VisualizationError instance
   */
  static dataFormatError(details: string): VisualizationError {
    return new VisualizationError(
      `Data format error: ${details}`,
      VisualizationErrorType.DATA_FORMAT_ERROR,
      { details }
    );
  }
  
  /**
   * Creates a VisualizationError for too many nodes
   * 
   * @param requested - Number of nodes requested
   * @param limit - Maximum allowed nodes
   * @returns A new VisualizationError instance
   */
  static tooManyNodes(requested: number, limit: number): VisualizationError {
    return new VisualizationError(
      `Too many nodes requested: ${requested} (limit: ${limit})`,
      VisualizationErrorType.TOO_MANY_NODES,
      { requested, limit }
    );
  }
  
  /**
   * Creates a VisualizationError for invalid entity type
   * 
   * @param entityType - The invalid entity type
   * @param validTypes - List of valid entity types
   * @returns A new VisualizationError instance
   */
  static invalidEntityType(entityType: string, validTypes: string[]): VisualizationError {
    return new VisualizationError(
      `Invalid entity type '${entityType}'. Valid types: ${validTypes.join(', ')}`,
      VisualizationErrorType.INVALID_ENTITY_TYPE,
      { entityType, validTypes }
    );
  }
  
  /**
   * Creates a VisualizationError for invalid document
   * 
   * @param documentName - The invalid document name
   * @returns A new VisualizationError instance
   */
  static invalidDocument(documentName: string): VisualizationError {
    return new VisualizationError(
      `Document '${documentName}' not found in the graph`,
      VisualizationErrorType.INVALID_DOCUMENT,
      { documentName }
    );
  }
  
  /**
   * Returns a formatted error message with all details
   */
  toDetailedString(): string {
    let details = `${this.name} [${this.errorType}]: ${this.message}`;
    
    if (this.context) {
      details += `\n  Context: ${JSON.stringify(this.context, null, 2)}`;
    }
    
    return details;
  }
}
