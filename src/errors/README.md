# Error Classes

This module provides custom error classes for the PDF Knowledge Graph system, implementing the error handling strategy defined in the design document.

## Overview

The error handling system classifies errors into two main categories:

1. **Recoverable Errors**: Can be retried with exponential backoff
2. **Non-Recoverable Errors**: Should be logged and handled without retry

## Error Classes

### ConfigurationError

Handles configuration-related errors, such as missing credentials or invalid .env files.

```typescript
import { ConfigurationError, ConfigErrorType } from './errors';

// Critical error (stops execution)
throw new ConfigurationError(
  'Missing required fields',
  ['NEO4J_URI', 'GOOGLE_API_KEY'],
  true,
  ConfigErrorType.MISSING_REQUIRED
);

// Non-critical error (warning only)
throw new ConfigurationError(
  'Optional field missing',
  ['OPTIONAL_FIELD'],
  false,
  ConfigErrorType.MISSING_OPTIONAL
);
```

**Error Types:**
- `FILE_NOT_FOUND`: .env file not found
- `MISSING_REQUIRED`: Required environment variable missing
- `INVALID_VALUE`: Invalid format or value
- `MISSING_OPTIONAL`: Optional variable missing (warning)

### PDFProcessingError

Handles errors during PDF processing operations.

```typescript
import { PDFProcessingError, PDFErrorType } from './errors';

// Non-recoverable error
throw new PDFProcessingError(
  'PDF is password protected',
  'secure.pdf',
  false,
  PDFErrorType.PASSWORD_PROTECTED
);

// Recoverable error
throw new PDFProcessingError(
  'Temporary read error',
  'document.pdf',
  true,
  PDFErrorType.READ_ERROR
);
```

**Error Types:**
- `PASSWORD_PROTECTED`: PDF requires password
- `CORRUPTED`: PDF file is corrupted
- `INVALID_FORMAT`: Not a valid PDF file
- `PERMISSION_DENIED`: No read permissions
- `READ_ERROR`: Temporary read error (recoverable)

### GenkitAPIError

Handles errors from Google Genkit API calls.

```typescript
import { GenkitAPIError } from './errors';

const requestDetails = {
  endpoint: '/api/analyze',
  textLength: 1000,
  timestamp: new Date()
};

// Create from response
const error = GenkitAPIError.fromResponse(
  429,
  'Rate limit exceeded',
  requestDetails
);

// Check if recoverable
if (error.isRecoverable) {
  // Retry with backoff
}
```

**Recoverable Status Codes:**
- `429`: Rate limiting
- `500`, `502`, `503`, `504`: Server errors

**Non-Recoverable Status Codes:**
- `400`: Bad request
- `401`: Invalid API key
- `403`: Quota exceeded

**Retry Configuration:**
```typescript
import { DEFAULT_RETRY_CONFIG } from './errors';

// Default configuration
{
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2
}
```

### Neo4jError

Handles errors from Neo4j database operations.

```typescript
import { 
  Neo4jError,
  Neo4jConnectionError,
  Neo4jAuthenticationError,
  Neo4jQueryError
} from './errors';

// Generic Neo4j error
const error = new Neo4jError(
  'Connection lost',
  true,
  'ServiceUnavailable'
);

// Specific error types
throw new Neo4jConnectionError('Cannot connect to database');
throw new Neo4jAuthenticationError();
throw new Neo4jQueryError('Syntax error', 'INVALID QUERY');

// Create from driver error
const driverError = { code: 'ServiceUnavailable', message: 'Connection lost' };
const error = Neo4jError.fromDriverError(driverError, 'MATCH (n) RETURN n');
```

**Specific Error Classes:**
- `Neo4jConnectionError`: Connection failures (recoverable)
- `Neo4jAuthenticationError`: Invalid credentials (non-recoverable)
- `Neo4jQueryError`: Syntax errors (non-recoverable)
- `Neo4jConstraintError`: Constraint violations (non-recoverable)
- `Neo4jTransactionTimeoutError`: Transaction timeouts (recoverable)

**Error Classification Methods:**
```typescript
Neo4jError.isRecoverableErrorCode(errorCode);
Neo4jError.isAuthError(errorCode);
Neo4jError.isSyntaxError(errorCode);
Neo4jError.isConstraintViolation(errorCode);
```

### VisualizationError

Handles errors in the visualization service.

```typescript
import { VisualizationError, VisualizationErrorType } from './errors';

// Factory methods for common errors
throw VisualizationError.invalidFilter({ maxNodes: -1 });
throw VisualizationError.nodeNotFound('node-123');
throw VisualizationError.queryTimeout(5000, 1000);
throw VisualizationError.dataFormatError('Missing required field');
throw VisualizationError.tooManyNodes(5000, 1000);
throw VisualizationError.invalidEntityType('INVALID', ['PERSON', 'LOCATION']);
throw VisualizationError.invalidDocument('missing.pdf');

// Check if recoverable
if (error.isRecoverable()) {
  // Only QUERY_TIMEOUT is recoverable
}
```

**Error Types:**
- `INVALID_FILTER`: Invalid filter parameters
- `NODE_NOT_FOUND`: Node doesn't exist
- `QUERY_TIMEOUT`: Query timed out (recoverable)
- `DATA_FORMAT_ERROR`: Data format incompatible
- `TOO_MANY_NODES`: Exceeds node limit
- `INVALID_ENTITY_TYPE`: Invalid entity type
- `INVALID_DOCUMENT`: Document not found

## Utility Functions

### isApplicationError

Checks if an error is a custom application error.

```typescript
import { isApplicationError } from './errors';

try {
  // ... operation
} catch (error) {
  if (isApplicationError(error)) {
    // Handle application error
  } else {
    // Handle standard error
  }
}
```

### isRecoverableError

Checks if an error can be retried.

```typescript
import { isRecoverableError } from './errors';

try {
  // ... operation
} catch (error) {
  if (isRecoverableError(error)) {
    // Retry with backoff
  } else {
    // Log and fail
  }
}
```

### getErrorMessage

Gets a user-friendly error message.

```typescript
import { getErrorMessage } from './errors';

try {
  // ... operation
} catch (error) {
  const message = getErrorMessage(error);
  console.log(message);
}
```

### getDetailedErrorInfo

Gets detailed error information for logging.

```typescript
import { getDetailedErrorInfo } from './errors';

try {
  // ... operation
} catch (error) {
  const details = getDetailedErrorInfo(error);
  logger.error(details);
}
```

## Error Handling Strategy

### Recoverable Errors

For recoverable errors, implement exponential backoff:

```typescript
import { isRecoverableError, DEFAULT_RETRY_CONFIG } from './errors';

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: any;
  let delay = config.initialDelayMs;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (!isRecoverableError(error) || attempt === config.maxRetries) {
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError;
}
```

### Non-Recoverable Errors

For non-recoverable errors, log and handle appropriately:

```typescript
import { getDetailedErrorInfo } from './errors';

try {
  // ... operation
} catch (error) {
  logger.error(getDetailedErrorInfo(error));
  
  // Handle based on error type
  if (error instanceof ConfigurationError && error.isCritical) {
    process.exit(1);
  }
  
  // Mark resource as failed
  await markAsFailed(resource, error.message);
}
```

## Testing

All error classes have comprehensive unit tests in `tests/errors.test.ts`:

```bash
npm test -- errors.test.ts
```

The tests cover:
- Error creation and properties
- Error classification (recoverable vs non-recoverable)
- Factory methods and static helpers
- Utility functions
- Error formatting and detailed strings

## Requirements

This module implements requirements:
- **8.3**: Error handling and classification
- **8.4**: Error logging with details
