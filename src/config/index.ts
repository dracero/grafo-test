/**
 * Configuration module
 * 
 * Exports all configuration types, interfaces, and utilities
 */

export type {
  // Interfaces
  Neo4jConfig,
  GoogleConfig,
  PdfFolderConfig,
  ProcessingConfig,
  VectorSearchConfig,
  SystemConfig,
  ValidationResult
} from './types';

export {
  // Enums
  EnvVariable,
  ConfigErrorType,
  
  // Constants
  REQUIRED_ENV_VARIABLES,
  DEFAULT_CONFIG,
  
  // Error classes
  ConfigurationError
} from './types';

export { ConfigurationManager } from './configuration-manager';
