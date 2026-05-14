/**
 * Configuration types for the PDF Knowledge Graph system
 * 
 * This module defines all configuration interfaces, types, and enums
 * used throughout the system for managing credentials, settings, and validation.
 */

/**
 * Neo4j database configuration
 * Contains connection credentials for the Neo4j graph database
 */
export interface Neo4jConfig {
  /** Neo4j database URI (e.g., "bolt://localhost:7687" or "neo4j://localhost:7687") */
  uri: string;
  
  /** Neo4j database username */
  username: string;
  
  /** Neo4j database password */
  password: string;
}

/**
 * Google API configuration
 * Contains credentials for Google Genkit and AI services
 */
export interface GoogleConfig {
  /** Google API key for Genkit and AI services */
  apiKey: string;
}

/**
 * PDF folder configuration
 * Defines paths for PDF processing and organization
 */
export interface PdfFolderConfig {
  /** Main path to the folder containing PDFs to process */
  path: string;
  
  /** Subfolder name for successfully processed PDFs (default: "processed") */
  processedSubfolder: string;
  
  /** Subfolder name for failed PDFs (default: "failed") */
  failedSubfolder: string;
}

/**
 * Processing configuration
 * Settings for retry logic and confidence thresholds
 */
export interface ProcessingConfig {
  /** Maximum number of retry attempts for recoverable errors */
  maxRetries: number;
  
  /** Initial delay in milliseconds between retry attempts */
  retryDelayMs: number;
  
  /** Minimum confidence threshold for accepting extracted entities (0-1) */
  confidenceThreshold: number;
}

/**
 * Vector search configuration
 * Settings for embeddings and similarity search
 */
export interface VectorSearchConfig {
  /** Dimensionality of embedding vectors (typically 768 for Google models) */
  embeddingDimensions: number;
  
  /** Similarity function to use for vector search */
  similarityFunction: 'cosine' | 'euclidean';
  
  /** Default maximum number of results to return from vector search */
  defaultLimit: number;
}

/**
 * Complete system configuration
 * Aggregates all configuration sections
 */
export interface SystemConfig {
  /** Neo4j database configuration */
  neo4j: Neo4jConfig;
  
  /** Google API configuration */
  google: GoogleConfig;
  
  /** PDF folder configuration */
  pdfFolder: PdfFolderConfig;
  
  /** Processing configuration */
  processing: ProcessingConfig;
  
  /** Vector search configuration */
  vectorSearch: VectorSearchConfig;
}

/**
 * Configuration validation result
 * Contains validation status and details about any issues
 */
export interface ValidationResult {
  /** Whether the configuration is valid and complete */
  isValid: boolean;
  
  /** List of required field names that are missing from the configuration */
  missingFields: string[];
  
  /** List of validation error messages */
  errors: string[];
}

/**
 * Required environment variable names
 * Defines the expected .env variable names for configuration
 */
export enum EnvVariable {
  NEO4J_URI = 'NEO4J_URI',
  NEO4J_USERNAME = 'NEO4J_USERNAME',
  NEO4J_PASSWORD = 'NEO4J_PASSWORD',
  GOOGLE_API_KEY = 'GOOGLE_API_KEY',
  PDF_FOLDER_PATH = 'PDF_FOLDER_PATH',
  PDF_PROCESSED_SUBFOLDER = 'PDF_PROCESSED_SUBFOLDER',
  PDF_FAILED_SUBFOLDER = 'PDF_FAILED_SUBFOLDER',
  MAX_RETRIES = 'MAX_RETRIES',
  RETRY_DELAY_MS = 'RETRY_DELAY_MS',
  CONFIDENCE_THRESHOLD = 'CONFIDENCE_THRESHOLD',
  EMBEDDING_DIMENSIONS = 'EMBEDDING_DIMENSIONS',
  SIMILARITY_FUNCTION = 'SIMILARITY_FUNCTION',
  DEFAULT_SEARCH_LIMIT = 'DEFAULT_SEARCH_LIMIT'
}

/**
 * List of required environment variables that must be present
 * These are critical for system operation
 */
export const REQUIRED_ENV_VARIABLES: EnvVariable[] = [
  EnvVariable.NEO4J_URI,
  EnvVariable.NEO4J_USERNAME,
  EnvVariable.NEO4J_PASSWORD,
  EnvVariable.GOOGLE_API_KEY,
  EnvVariable.PDF_FOLDER_PATH
];

/**
 * Default configuration values
 * Used when optional environment variables are not provided
 */
export const DEFAULT_CONFIG = {
  pdfFolder: {
    processedSubfolder: 'processed',
    failedSubfolder: 'failed'
  },
  processing: {
    maxRetries: 3,
    retryDelayMs: 1000,
    confidenceThreshold: 0.7
  },
  vectorSearch: {
    embeddingDimensions: 768,
    similarityFunction: 'cosine' as const,
    defaultLimit: 10
  }
};

/**
 * Configuration error types
 * Categorizes different kinds of configuration errors
 */
export enum ConfigErrorType {
  /** .env file not found */
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  
  /** Required environment variable is missing */
  MISSING_REQUIRED = 'MISSING_REQUIRED',
  
  /** Environment variable has invalid format or value */
  INVALID_VALUE = 'INVALID_VALUE',
  
  /** Optional environment variable is missing (warning only) */
  MISSING_OPTIONAL = 'MISSING_OPTIONAL'
}

/**
 * Custom error class for configuration-related errors
 */
export class ConfigurationError extends Error {
  constructor(
    message: string,
    public readonly missingFields: string[],
    public readonly isCritical: boolean,
    public readonly errorType: ConfigErrorType
  ) {
    super(message);
    this.name = 'ConfigurationError';
    
    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConfigurationError);
    }
  }
}
