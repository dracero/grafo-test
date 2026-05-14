/**
 * Unit tests for custom error classes
 * 
 * Tests all custom error classes to ensure proper error handling,
 * classification (recoverable vs non-recoverable), and error details.
 * 
 * Feature: pdf-knowledge-graph
 * Task: 13.1 Crear clases de error personalizadas
 */

import {
  ConfigurationError,
  ConfigErrorType,
  PDFProcessingError,
  PDFErrorType,
  GenkitAPIError,
  RequestDetails,
  DEFAULT_RETRY_CONFIG,
  Neo4jError,
  Neo4jConnectionError,
  Neo4jAuthenticationError,
  Neo4jQueryError,
  Neo4jConstraintError,
  Neo4jTransactionTimeoutError,
  VisualizationError,
  VisualizationErrorType,
  isApplicationError,
  isRecoverableError,
  getErrorMessage,
  getDetailedErrorInfo
} from '../src/errors';

describe('Error Classes', () => {
  describe('ConfigurationError', () => {
    it('should create a critical configuration error', () => {
      const error = new ConfigurationError(
        'Missing required fields',
        ['NEO4J_URI', 'GOOGLE_API_KEY'],
        true,
        ConfigErrorType.MISSING_REQUIRED
      );

      expect(error.message).toBe('Missing required fields');
      expect(error.missingFields).toEqual(['NEO4J_URI', 'GOOGLE_API_KEY']);
      expect(error.isCritical).toBe(true);
      expect(error.errorType).toBe(ConfigErrorType.MISSING_REQUIRED);
      expect(error.name).toBe('ConfigurationError');
      expect(error instanceof Error).toBe(true);
      expect(error instanceof ConfigurationError).toBe(true);
    });

    it('should create a non-critical configuration error', () => {
      const error = new ConfigurationError(
        'Optional field missing',
        ['OPTIONAL_FIELD'],
        false,
        ConfigErrorType.MISSING_OPTIONAL
      );

      expect(error.isCritical).toBe(false);
      expect(error.errorType).toBe(ConfigErrorType.MISSING_OPTIONAL);
    });

    it('should have proper stack trace', () => {
      const error = new ConfigurationError(
        'Test error',
        [],
        true,
        ConfigErrorType.FILE_NOT_FOUND
      );

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('ConfigurationError');
    });
  });

  describe('PDFProcessingError', () => {
    it('should create a non-recoverable PDF error', () => {
      const error = new PDFProcessingError(
        'PDF is password protected',
        'secure.pdf',
        false,
        PDFErrorType.PASSWORD_PROTECTED
      );

      expect(error.message).toBe('PDF is password protected');
      expect(error.fileName).toBe('secure.pdf');
      expect(error.isRecoverable).toBe(false);
      expect(error.errorType).toBe(PDFErrorType.PASSWORD_PROTECTED);
      expect(error.name).toBe('PDFProcessingError');
    });

    it('should create a recoverable PDF error', () => {
      const error = new PDFProcessingError(
        'Temporary read error',
        'document.pdf',
        true,
        PDFErrorType.READ_ERROR
      );

      expect(error.isRecoverable).toBe(true);
      expect(error.errorType).toBe(PDFErrorType.READ_ERROR);
    });
  });

  describe('GenkitAPIError', () => {
    const requestDetails: RequestDetails = {
      endpoint: '/api/analyze',
      textLength: 1000,
      timestamp: new Date('2024-01-01T00:00:00Z')
    };

    it('should create a recoverable API error (rate limiting)', () => {
      const error = new GenkitAPIError(
        'Rate limit exceeded',
        429,
        true,
        requestDetails
      );

      expect(error.message).toBe('Rate limit exceeded');
      expect(error.statusCode).toBe(429);
      expect(error.isRecoverable).toBe(true);
      expect(error.requestDetails).toEqual(requestDetails);
      expect(error.name).toBe('GenkitAPIError');
    });

    it('should create a non-recoverable API error (invalid key)', () => {
      const error = new GenkitAPIError(
        'Invalid API key',
        401,
        false,
        requestDetails
      );

      expect(error.statusCode).toBe(401);
      expect(error.isRecoverable).toBe(false);
    });

    it('should correctly identify recoverable status codes', () => {
      expect(GenkitAPIError.isRecoverableStatusCode(429)).toBe(true);
      expect(GenkitAPIError.isRecoverableStatusCode(500)).toBe(true);
      expect(GenkitAPIError.isRecoverableStatusCode(502)).toBe(true);
      expect(GenkitAPIError.isRecoverableStatusCode(503)).toBe(true);
      expect(GenkitAPIError.isRecoverableStatusCode(504)).toBe(true);
      
      expect(GenkitAPIError.isRecoverableStatusCode(400)).toBe(false);
      expect(GenkitAPIError.isRecoverableStatusCode(401)).toBe(false);
      expect(GenkitAPIError.isRecoverableStatusCode(403)).toBe(false);
    });

    it('should create error from response', () => {
      const error = GenkitAPIError.fromResponse(
        429,
        'Too many requests',
        requestDetails
      );

      expect(error.statusCode).toBe(429);
      expect(error.message).toBe('Too many requests');
      expect(error.isRecoverable).toBe(true);
    });

    it('should format detailed error string', () => {
      const error = new GenkitAPIError(
        'Test error',
        500,
        true,
        requestDetails
      );

      const detailed = error.toDetailedString();
      expect(detailed).toContain('GenkitAPIError');
      expect(detailed).toContain('500');
      expect(detailed).toContain('/api/analyze');
      expect(detailed).toContain('1000');
      expect(detailed).toContain('Recoverable: true');
    });

    it('should have default retry config', () => {
      expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBe(1000);
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(10000);
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
    });
  });

  describe('Neo4jError', () => {
    it('should create a recoverable Neo4j error', () => {
      const error = new Neo4jError(
        'Connection lost',
        true,
        'ServiceUnavailable'
      );

      expect(error.message).toBe('Connection lost');
      expect(error.isRecoverable).toBe(true);
      expect(error.errorCode).toBe('ServiceUnavailable');
      expect(error.name).toBe('Neo4jError');
    });

    it('should create a non-recoverable Neo4j error with query', () => {
      const query = 'CREATE (n:Node {name: $name})';
      const error = new Neo4jError(
        'Syntax error',
        false,
        'Neo.ClientError.Statement.SyntaxError',
        query
      );

      expect(error.isRecoverable).toBe(false);
      expect(error.query).toBe(query);
    });

    it('should correctly identify recoverable error codes', () => {
      expect(Neo4jError.isRecoverableErrorCode('ServiceUnavailable')).toBe(true);
      expect(Neo4jError.isRecoverableErrorCode('SessionExpired')).toBe(true);
      expect(Neo4jError.isRecoverableErrorCode('TransientError')).toBe(true);
      expect(Neo4jError.isRecoverableErrorCode('DeadlockDetected')).toBe(true);
      expect(Neo4jError.isRecoverableErrorCode('TransactionTimeout')).toBe(true);
      
      expect(Neo4jError.isRecoverableErrorCode('Security.Unauthorized')).toBe(false);
      expect(Neo4jError.isRecoverableErrorCode('Statement.SyntaxError')).toBe(false);
    });

    it('should identify auth errors', () => {
      expect(Neo4jError.isAuthError('Neo.ClientError.Security.Unauthorized')).toBe(true);
      expect(Neo4jError.isAuthError('Neo.ClientError.Security.Forbidden')).toBe(true);
      expect(Neo4jError.isAuthError('ServiceUnavailable')).toBe(false);
    });

    it('should identify syntax errors', () => {
      expect(Neo4jError.isSyntaxError('Neo.ClientError.Statement.SyntaxError')).toBe(true);
      expect(Neo4jError.isSyntaxError('Neo.ClientError.Statement.SemanticError')).toBe(true);
      expect(Neo4jError.isSyntaxError('ServiceUnavailable')).toBe(false);
    });

    it('should identify constraint violations', () => {
      expect(Neo4jError.isConstraintViolation('Schema.ConstraintValidationFailed')).toBe(true);
      expect(Neo4jError.isConstraintViolation('Schema.ConstraintViolation')).toBe(true);
      expect(Neo4jError.isConstraintViolation('ServiceUnavailable')).toBe(false);
    });

    it('should create error from driver error', () => {
      const driverError = {
        code: 'ServiceUnavailable',
        message: 'Could not connect to database'
      };

      const error = Neo4jError.fromDriverError(driverError, 'MATCH (n) RETURN n');
      expect(error.errorCode).toBe('ServiceUnavailable');
      expect(error.message).toBe('Could not connect to database');
      expect(error.isRecoverable).toBe(true);
      expect(error.query).toBe('MATCH (n) RETURN n');
    });

    it('should format detailed error string', () => {
      const error = new Neo4jError(
        'Test error',
        true,
        'ServiceUnavailable',
        'MATCH (n) RETURN n'
      );

      const detailed = error.toDetailedString();
      expect(detailed).toContain('Neo4jError');
      expect(detailed).toContain('ServiceUnavailable');
      expect(detailed).toContain('Recoverable: true');
      expect(detailed).toContain('MATCH (n) RETURN n');
    });
  });

  describe('Neo4j Specific Error Classes', () => {
    it('should create Neo4jConnectionError', () => {
      const error = new Neo4jConnectionError('Cannot connect to database');
      
      expect(error.name).toBe('Neo4jConnectionError');
      expect(error.isRecoverable).toBe(true);
      expect(error.errorCode).toBe('ServiceUnavailable');
    });

    it('should create Neo4jAuthenticationError', () => {
      const error = new Neo4jAuthenticationError();
      
      expect(error.name).toBe('Neo4jAuthenticationError');
      expect(error.isRecoverable).toBe(false);
      expect(error.errorCode).toBe('Neo.ClientError.Security.Unauthorized');
      expect(error.message).toBe('Invalid Neo4j credentials');
    });

    it('should create Neo4jQueryError', () => {
      const query = 'INVALID QUERY';
      const error = new Neo4jQueryError('Syntax error in query', query);
      
      expect(error.name).toBe('Neo4jQueryError');
      expect(error.isRecoverable).toBe(false);
      expect(error.query).toBe(query);
    });

    it('should create Neo4jConstraintError', () => {
      const error = new Neo4jConstraintError('Unique constraint violated');
      
      expect(error.name).toBe('Neo4jConstraintError');
      expect(error.isRecoverable).toBe(false);
    });

    it('should create Neo4jTransactionTimeoutError', () => {
      const error = new Neo4jTransactionTimeoutError();
      
      expect(error.name).toBe('Neo4jTransactionTimeoutError');
      expect(error.isRecoverable).toBe(true);
      expect(error.message).toBe('Transaction timeout');
    });
  });

  describe('VisualizationError', () => {
    it('should create an invalid filter error', () => {
      const error = VisualizationError.invalidFilter({ maxNodes: -1 });
      
      expect(error.errorType).toBe(VisualizationErrorType.INVALID_FILTER);
      expect(error.message).toBe('Invalid filter parameters provided');
      expect(error.context).toEqual({ maxNodes: -1 });
      expect(error.name).toBe('VisualizationError');
    });

    it('should create a node not found error', () => {
      const error = VisualizationError.nodeNotFound('node-123');
      
      expect(error.errorType).toBe(VisualizationErrorType.NODE_NOT_FOUND);
      expect(error.message).toContain('node-123');
      expect(error.context).toEqual({ nodeId: 'node-123' });
    });

    it('should create a query timeout error', () => {
      const error = VisualizationError.queryTimeout(5000, 1000);
      
      expect(error.errorType).toBe(VisualizationErrorType.QUERY_TIMEOUT);
      expect(error.message).toContain('5000ms');
      expect(error.context).toEqual({ timeoutMs: 5000, nodeCount: 1000 });
    });

    it('should create a data format error', () => {
      const error = VisualizationError.dataFormatError('Missing required field');
      
      expect(error.errorType).toBe(VisualizationErrorType.DATA_FORMAT_ERROR);
      expect(error.message).toContain('Missing required field');
    });

    it('should create a too many nodes error', () => {
      const error = VisualizationError.tooManyNodes(5000, 1000);
      
      expect(error.errorType).toBe(VisualizationErrorType.TOO_MANY_NODES);
      expect(error.message).toContain('5000');
      expect(error.message).toContain('1000');
    });

    it('should create an invalid entity type error', () => {
      const error = VisualizationError.invalidEntityType('INVALID', ['PERSON', 'LOCATION']);
      
      expect(error.errorType).toBe(VisualizationErrorType.INVALID_ENTITY_TYPE);
      expect(error.message).toContain('INVALID');
      expect(error.message).toContain('PERSON');
    });

    it('should create an invalid document error', () => {
      const error = VisualizationError.invalidDocument('missing.pdf');
      
      expect(error.errorType).toBe(VisualizationErrorType.INVALID_DOCUMENT);
      expect(error.message).toContain('missing.pdf');
    });

    it('should correctly identify recoverable errors', () => {
      const timeoutError = VisualizationError.queryTimeout(5000);
      const filterError = VisualizationError.invalidFilter({});
      
      expect(timeoutError.isRecoverable()).toBe(true);
      expect(filterError.isRecoverable()).toBe(false);
    });

    it('should format detailed error string', () => {
      const error = VisualizationError.nodeNotFound('node-123');
      const detailed = error.toDetailedString();
      
      expect(detailed).toContain('VisualizationError');
      expect(detailed).toContain('NODE_NOT_FOUND');
      expect(detailed).toContain('node-123');
    });
  });

  describe('Error Utility Functions', () => {
    describe('isApplicationError', () => {
      it('should identify application errors', () => {
        const configError = new ConfigurationError('test', [], true, ConfigErrorType.FILE_NOT_FOUND);
        const pdfError = new PDFProcessingError('test', 'file.pdf', false, PDFErrorType.CORRUPTED);
        const genkitError = new GenkitAPIError('test', 500, true, {
          endpoint: '/test',
          textLength: 100,
          timestamp: new Date()
        });
        const neo4jError = new Neo4jError('test', true, 'ServiceUnavailable');
        const vizError = VisualizationError.nodeNotFound('node-1');
        
        expect(isApplicationError(configError)).toBe(true);
        expect(isApplicationError(pdfError)).toBe(true);
        expect(isApplicationError(genkitError)).toBe(true);
        expect(isApplicationError(neo4jError)).toBe(true);
        expect(isApplicationError(vizError)).toBe(true);
      });

      it('should not identify standard errors as application errors', () => {
        const standardError = new Error('Standard error');
        expect(isApplicationError(standardError)).toBe(false);
      });
    });

    describe('isRecoverableError', () => {
      it('should identify recoverable errors', () => {
        const recoverableConfig = new ConfigurationError('test', [], false, ConfigErrorType.MISSING_OPTIONAL);
        const recoverablePdf = new PDFProcessingError('test', 'file.pdf', true, PDFErrorType.READ_ERROR);
        const recoverableGenkit = new GenkitAPIError('test', 429, true, {
          endpoint: '/test',
          textLength: 100,
          timestamp: new Date()
        });
        const recoverableNeo4j = new Neo4jError('test', true, 'ServiceUnavailable');
        const recoverableViz = VisualizationError.queryTimeout(5000);
        
        expect(isRecoverableError(recoverableConfig)).toBe(true);
        expect(isRecoverableError(recoverablePdf)).toBe(true);
        expect(isRecoverableError(recoverableGenkit)).toBe(true);
        expect(isRecoverableError(recoverableNeo4j)).toBe(true);
        expect(isRecoverableError(recoverableViz)).toBe(true);
      });

      it('should identify non-recoverable errors', () => {
        const nonRecoverableConfig = new ConfigurationError('test', [], true, ConfigErrorType.MISSING_REQUIRED);
        const nonRecoverablePdf = new PDFProcessingError('test', 'file.pdf', false, PDFErrorType.CORRUPTED);
        const nonRecoverableGenkit = new GenkitAPIError('test', 401, false, {
          endpoint: '/test',
          textLength: 100,
          timestamp: new Date()
        });
        const nonRecoverableNeo4j = new Neo4jError('test', false, 'Security.Unauthorized');
        const nonRecoverableViz = VisualizationError.nodeNotFound('node-1');
        
        expect(isRecoverableError(nonRecoverableConfig)).toBe(false);
        expect(isRecoverableError(nonRecoverablePdf)).toBe(false);
        expect(isRecoverableError(nonRecoverableGenkit)).toBe(false);
        expect(isRecoverableError(nonRecoverableNeo4j)).toBe(false);
        expect(isRecoverableError(nonRecoverableViz)).toBe(false);
      });

      it('should return false for non-application errors', () => {
        const standardError = new Error('Standard error');
        expect(isRecoverableError(standardError)).toBe(false);
      });
    });

    describe('getErrorMessage', () => {
      it('should get message from application errors', () => {
        const error = new ConfigurationError('Config error', [], true, ConfigErrorType.FILE_NOT_FOUND);
        expect(getErrorMessage(error)).toBe('Config error');
      });

      it('should get message from standard errors', () => {
        const error = new Error('Standard error');
        expect(getErrorMessage(error)).toBe('Standard error');
      });

      it('should convert non-error values to string', () => {
        expect(getErrorMessage('string error')).toBe('string error');
        expect(getErrorMessage(123)).toBe('123');
      });
    });

    describe('getDetailedErrorInfo', () => {
      it('should get detailed info from GenkitAPIError', () => {
        const error = new GenkitAPIError('Test', 500, true, {
          endpoint: '/test',
          textLength: 100,
          timestamp: new Date()
        });
        
        const info = getDetailedErrorInfo(error);
        expect(info).toContain('GenkitAPIError');
        expect(info).toContain('500');
        expect(info).toContain('/test');
      });

      it('should get detailed info from Neo4jError', () => {
        const error = new Neo4jError('Test', true, 'ServiceUnavailable', 'MATCH (n) RETURN n');
        const info = getDetailedErrorInfo(error);
        
        expect(info).toContain('Neo4jError');
        expect(info).toContain('ServiceUnavailable');
        expect(info).toContain('MATCH (n) RETURN n');
      });

      it('should get detailed info from VisualizationError', () => {
        const error = VisualizationError.nodeNotFound('node-123');
        const info = getDetailedErrorInfo(error);
        
        expect(info).toContain('VisualizationError');
        expect(info).toContain('NODE_NOT_FOUND');
      });

      it('should get info from standard errors', () => {
        const error = new Error('Standard error');
        const info = getDetailedErrorInfo(error);
        
        expect(info).toContain('Error');
        expect(info).toContain('Standard error');
      });
    });
  });
});
