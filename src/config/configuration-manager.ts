/**
 * Configuration Manager Implementation
 * 
 * Responsible for loading, validating, and serializing system configuration
 * from environment variables.
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 10.3, 10.4
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {
  SystemConfig,
  Neo4jConfig,
  GoogleConfig,
  PdfFolderConfig,
  ProcessingConfig,
  VectorSearchConfig,
  ValidationResult,
  EnvVariable,
  REQUIRED_ENV_VARIABLES,
  DEFAULT_CONFIG,
  ConfigErrorType,
  ConfigurationError
} from './types';

/**
 * Manages system configuration lifecycle: loading, validation, and serialization.
 * 
 * Usage:
 * ```ts
 * const manager = new ConfigurationManager();
 * await manager.load();
 * const validation = manager.validate();
 * if (validation.isValid) {
 *   const neo4jConfig = manager.getNeo4jConfig();
 * }
 * ```
 */
export class ConfigurationManager {
  private config: SystemConfig | null = null;
  private envPath: string;
  private warnings: string[] = [];

  /**
   * Creates a new ConfigurationManager
   * @param envPath - Path to the .env file (default: project root)
   */
  constructor(envPath?: string) {
    this.envPath = envPath || path.resolve(process.cwd(), '.env');
  }

  /**
   * Loads configuration from the .env file and environment variables.
   * Environment variables take precedence over .env file values.
   * 
   * @throws {ConfigurationError} If the .env file cannot be read (warning only, continues with env vars)
   * Requirements: 3.1, 3.2
   */
  load(): void {
    this.warnings = [];

    // Attempt to load .env file
    const envFileExists = fs.existsSync(this.envPath);
    if (envFileExists) {
      dotenv.config({ path: this.envPath });
    } else {
      this.warnings.push(`Warning: .env file not found at ${this.envPath}. Using environment variables only.`);
    }

    // Build configuration from environment variables
    this.config = {
      neo4j: {
        uri: process.env[EnvVariable.NEO4J_URI] || '',
        username: process.env[EnvVariable.NEO4J_USERNAME] || '',
        password: process.env[EnvVariable.NEO4J_PASSWORD] || ''
      },
      google: {
        apiKey: process.env[EnvVariable.GOOGLE_API_KEY] || ''
      },
      pdfFolder: {
        path: process.env[EnvVariable.PDF_FOLDER_PATH] || '',
        processedSubfolder: process.env[EnvVariable.PDF_PROCESSED_SUBFOLDER] || DEFAULT_CONFIG.pdfFolder.processedSubfolder,
        failedSubfolder: process.env[EnvVariable.PDF_FAILED_SUBFOLDER] || DEFAULT_CONFIG.pdfFolder.failedSubfolder
      },
      processing: {
        maxRetries: this.parseIntWithDefault(
          process.env[EnvVariable.MAX_RETRIES],
          DEFAULT_CONFIG.processing.maxRetries
        ),
        retryDelayMs: this.parseIntWithDefault(
          process.env[EnvVariable.RETRY_DELAY_MS],
          DEFAULT_CONFIG.processing.retryDelayMs
        ),
        confidenceThreshold: this.parseFloatWithDefault(
          process.env[EnvVariable.CONFIDENCE_THRESHOLD],
          DEFAULT_CONFIG.processing.confidenceThreshold
        )
      },
      vectorSearch: {
        embeddingDimensions: this.parseIntWithDefault(
          process.env[EnvVariable.EMBEDDING_DIMENSIONS],
          DEFAULT_CONFIG.vectorSearch.embeddingDimensions
        ),
        similarityFunction: this.parseSimilarityFunction(
          process.env[EnvVariable.SIMILARITY_FUNCTION]
        ),
        defaultLimit: this.parseIntWithDefault(
          process.env[EnvVariable.DEFAULT_SEARCH_LIMIT],
          DEFAULT_CONFIG.vectorSearch.defaultLimit
        )
      }
    };

    // Log warnings for optional fields using defaults
    this.checkOptionalWarnings();
  }

  /**
   * Validates the current configuration.
   * Checks that all required fields are present and have valid values.
   * 
   * @returns ValidationResult with status and details
   * Requirements: 3.4, 3.5, 3.6
   */
  validate(): ValidationResult {
    if (!this.config) {
      return {
        isValid: false,
        missingFields: ['ALL'],
        errors: ['Configuration has not been loaded. Call load() first.']
      };
    }

    const missingFields: string[] = [];
    const errors: string[] = [];

    // Check required environment variables
    const fieldMap: Record<string, string> = {
      [EnvVariable.NEO4J_URI]: this.config.neo4j.uri,
      [EnvVariable.NEO4J_USERNAME]: this.config.neo4j.username,
      [EnvVariable.NEO4J_PASSWORD]: this.config.neo4j.password,
      [EnvVariable.GOOGLE_API_KEY]: this.config.google.apiKey,
      [EnvVariable.PDF_FOLDER_PATH]: this.config.pdfFolder.path
    };

    for (const [field, value] of Object.entries(fieldMap)) {
      if (!value || value.trim() === '') {
        missingFields.push(field);
        errors.push(`Required field '${field}' is missing or empty.`);
      }
    }

    // Validate numeric ranges
    if (this.config.processing.confidenceThreshold < 0 || this.config.processing.confidenceThreshold > 1) {
      errors.push(`CONFIDENCE_THRESHOLD must be between 0 and 1, got: ${this.config.processing.confidenceThreshold}`);
    }

    if (this.config.processing.maxRetries < 0) {
      errors.push(`MAX_RETRIES must be non-negative, got: ${this.config.processing.maxRetries}`);
    }

    if (this.config.processing.retryDelayMs < 0) {
      errors.push(`RETRY_DELAY_MS must be non-negative, got: ${this.config.processing.retryDelayMs}`);
    }

    if (this.config.vectorSearch.embeddingDimensions <= 0) {
      errors.push(`EMBEDDING_DIMENSIONS must be positive, got: ${this.config.vectorSearch.embeddingDimensions}`);
    }

    if (this.config.vectorSearch.defaultLimit <= 0) {
      errors.push(`DEFAULT_SEARCH_LIMIT must be positive, got: ${this.config.vectorSearch.defaultLimit}`);
    }

    return {
      isValid: missingFields.length === 0 && errors.length === missingFields.length,
      missingFields,
      errors
    };
  }

  /**
   * Serializes the current configuration to .env format string.
   * 
   * @returns Configuration as a string in .env format (KEY=value pairs)
   * @throws {ConfigurationError} If configuration has not been loaded
   * Requirements: 10.3
   */
  serialize(): string {
    if (!this.config) {
      throw new ConfigurationError(
        'Configuration has not been loaded. Call load() first.',
        ['ALL'],
        true,
        ConfigErrorType.FILE_NOT_FOUND
      );
    }

    const lines: string[] = [
      `${EnvVariable.NEO4J_URI}=${this.config.neo4j.uri}`,
      `${EnvVariable.NEO4J_USERNAME}=${this.config.neo4j.username}`,
      `${EnvVariable.NEO4J_PASSWORD}=${this.config.neo4j.password}`,
      `${EnvVariable.GOOGLE_API_KEY}=${this.config.google.apiKey}`,
      `${EnvVariable.PDF_FOLDER_PATH}=${this.config.pdfFolder.path}`,
      `${EnvVariable.PDF_PROCESSED_SUBFOLDER}=${this.config.pdfFolder.processedSubfolder}`,
      `${EnvVariable.PDF_FAILED_SUBFOLDER}=${this.config.pdfFolder.failedSubfolder}`,
      `${EnvVariable.MAX_RETRIES}=${this.config.processing.maxRetries}`,
      `${EnvVariable.RETRY_DELAY_MS}=${this.config.processing.retryDelayMs}`,
      `${EnvVariable.CONFIDENCE_THRESHOLD}=${this.config.processing.confidenceThreshold}`,
      `${EnvVariable.EMBEDDING_DIMENSIONS}=${this.config.vectorSearch.embeddingDimensions}`,
      `${EnvVariable.SIMILARITY_FUNCTION}=${this.config.vectorSearch.similarityFunction}`,
      `${EnvVariable.DEFAULT_SEARCH_LIMIT}=${this.config.vectorSearch.defaultLimit}`
    ];

    return lines.join('\n');
  }

  /**
   * Parses a serialized .env string back into a SystemConfig object.
   * 
   * @param envString - Configuration in .env format
   * @returns Parsed SystemConfig
   * Requirements: 10.4
   */
  static parse(envString: string): SystemConfig {
    const vars: Record<string, string> = {};
    
    for (const line of envString.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      vars[key] = value;
    }

    return {
      neo4j: {
        uri: vars[EnvVariable.NEO4J_URI] || '',
        username: vars[EnvVariable.NEO4J_USERNAME] || '',
        password: vars[EnvVariable.NEO4J_PASSWORD] || ''
      },
      google: {
        apiKey: vars[EnvVariable.GOOGLE_API_KEY] || ''
      },
      pdfFolder: {
        path: vars[EnvVariable.PDF_FOLDER_PATH] || '',
        processedSubfolder: vars[EnvVariable.PDF_PROCESSED_SUBFOLDER] || DEFAULT_CONFIG.pdfFolder.processedSubfolder,
        failedSubfolder: vars[EnvVariable.PDF_FAILED_SUBFOLDER] || DEFAULT_CONFIG.pdfFolder.failedSubfolder
      },
      processing: {
        maxRetries: parseInt(vars[EnvVariable.MAX_RETRIES], 10) || DEFAULT_CONFIG.processing.maxRetries,
        retryDelayMs: parseInt(vars[EnvVariable.RETRY_DELAY_MS], 10) || DEFAULT_CONFIG.processing.retryDelayMs,
        confidenceThreshold: parseFloat(vars[EnvVariable.CONFIDENCE_THRESHOLD]) || DEFAULT_CONFIG.processing.confidenceThreshold
      },
      vectorSearch: {
        embeddingDimensions: parseInt(vars[EnvVariable.EMBEDDING_DIMENSIONS], 10) || DEFAULT_CONFIG.vectorSearch.embeddingDimensions,
        similarityFunction: (vars[EnvVariable.SIMILARITY_FUNCTION] === 'euclidean' ? 'euclidean' : 'cosine'),
        defaultLimit: parseInt(vars[EnvVariable.DEFAULT_SEARCH_LIMIT], 10) || DEFAULT_CONFIG.vectorSearch.defaultLimit
      }
    };
  }

  // ─── Getters ────────────────────────────────────────────────────────

  /** Returns the complete system configuration */
  getConfig(): SystemConfig {
    this.ensureLoaded();
    return this.config!;
  }

  /** Returns Neo4j database configuration */
  getNeo4jConfig(): Neo4jConfig {
    this.ensureLoaded();
    return this.config!.neo4j;
  }

  /** Returns Google API configuration */
  getGoogleConfig(): GoogleConfig {
    this.ensureLoaded();
    return this.config!.google;
  }

  /** Returns PDF folder configuration */
  getPdfFolderConfig(): PdfFolderConfig {
    this.ensureLoaded();
    return this.config!.pdfFolder;
  }

  /** Returns processing configuration */
  getProcessingConfig(): ProcessingConfig {
    this.ensureLoaded();
    return this.config!.processing;
  }

  /** Returns vector search configuration */
  getVectorSearchConfig(): VectorSearchConfig {
    this.ensureLoaded();
    return this.config!.vectorSearch;
  }

  /** Returns any warnings generated during loading */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private ensureLoaded(): void {
    if (!this.config) {
      throw new ConfigurationError(
        'Configuration has not been loaded. Call load() first.',
        ['ALL'],
        true,
        ConfigErrorType.FILE_NOT_FOUND
      );
    }
  }

  private parseIntWithDefault(value: string | undefined, defaultValue: number): number {
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  private parseFloatWithDefault(value: string | undefined, defaultValue: number): number {
    if (!value) return defaultValue;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  private parseSimilarityFunction(value: string | undefined): 'cosine' | 'euclidean' {
    if (value === 'euclidean') return 'euclidean';
    return DEFAULT_CONFIG.vectorSearch.similarityFunction;
  }

  private checkOptionalWarnings(): void {
    const optionalVars = [
      EnvVariable.PDF_PROCESSED_SUBFOLDER,
      EnvVariable.PDF_FAILED_SUBFOLDER,
      EnvVariable.MAX_RETRIES,
      EnvVariable.RETRY_DELAY_MS,
      EnvVariable.CONFIDENCE_THRESHOLD,
      EnvVariable.EMBEDDING_DIMENSIONS,
      EnvVariable.SIMILARITY_FUNCTION,
      EnvVariable.DEFAULT_SEARCH_LIMIT
    ];

    for (const varName of optionalVars) {
      if (!process.env[varName]) {
        this.warnings.push(`Optional variable '${varName}' not set, using default value.`);
      }
    }
  }
}
