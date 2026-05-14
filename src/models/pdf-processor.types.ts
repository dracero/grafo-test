/**
 * PDF Processor Types and Interfaces
 * 
 * Defines the core types and interfaces for PDF processing functionality.
 * Validates Requirements 2.1, 2.2
 */

/**
 * Status of PDF processing operation
 */
export enum ProcessingStatus {
  SUCCESS = 'processed',
  FAILED = 'failed'
}

/**
 * Type of error that occurred during PDF processing
 */
export enum PDFErrorType {
  PASSWORD_PROTECTED = 'PASSWORD_PROTECTED',
  CORRUPTED = 'CORRUPTED',
  INVALID_FORMAT = 'INVALID_FORMAT',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  READ_ERROR = 'READ_ERROR'
}

/**
 * Metadata about a processed PDF document
 */
export interface PDFMetadata {
  fileName: string;
  pageCount: number;
  timestamp: Date;
}

/**
 * Result of text extraction from a PDF document
 */
export interface ExtractionResult {
  success: boolean;
  text?: string;
  paragraphs?: string[];
  error?: string;
  metadata: PDFMetadata;
}

/**
 * Information about a failed PDF processing operation
 */
export interface FailedFile {
  fileName: string;
  error: string;
}

/**
 * Summary report of batch PDF processing
 */
export interface ProcessingReport {
  totalFiles: number;
  successCount: number;
  failedCount: number;
  processedFiles: string[];
  failedFiles: FailedFile[];
}

/**
 * Main interface for PDF processing operations
 */
export interface PDFProcessor {
  /**
   * Initializes the processor and verifies the PDF folder exists
   * Creates the folder if it doesn't exist
   */
  initialize(): Promise<void>;

  /**
   * Scans the PDF folder and returns list of pending PDF files
   * @returns Array of file paths for PDF files found
   */
  scanFolder(): Promise<string[]>;

  /**
   * Extracts text from a specific PDF file
   * @param filePath - Path to the PDF file to process
   * @returns Extraction result with text, paragraphs, and metadata
   */
  extractText(filePath: string): Promise<ExtractionResult>;

  /**
   * Moves a processed file to the appropriate subfolder
   * @param filePath - Path to the file to move
   * @param status - Processing status (SUCCESS or FAILED)
   */
  moveProcessedFile(filePath: string, status: ProcessingStatus): Promise<void>;

  /**
   * Processes all PDF files in the folder
   * @returns Processing report with statistics
   */
  processAll(): Promise<ProcessingReport>;
}

/**
 * Custom error class for PDF processing errors
 */
export class PDFProcessingError extends Error {
  constructor(
    message: string,
    public readonly fileName: string,
    public readonly isRecoverable: boolean,
    public readonly errorType: PDFErrorType
  ) {
    super(message);
    this.name = 'PDFProcessingError';
    Object.setPrototypeOf(this, PDFProcessingError.prototype);
  }
}
