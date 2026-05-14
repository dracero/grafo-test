/**
 * Unit tests for PDF Processor types and interfaces
 * 
 * Validates that the types are correctly defined and can be used
 */

import {
  ProcessingStatus,
  PDFErrorType,
  PDFMetadata,
  ExtractionResult,
  FailedFile,
  ProcessingReport,
  PDFProcessor,
  PDFProcessingError
} from '../src/models/pdf-processor.types';

describe('PDF Processor Types', () => {
  describe('ProcessingStatus enum', () => {
    it('should have SUCCESS status', () => {
      expect(ProcessingStatus.SUCCESS).toBe('processed');
    });

    it('should have FAILED status', () => {
      expect(ProcessingStatus.FAILED).toBe('failed');
    });
  });

  describe('PDFErrorType enum', () => {
    it('should have all error types defined', () => {
      expect(PDFErrorType.PASSWORD_PROTECTED).toBe('PASSWORD_PROTECTED');
      expect(PDFErrorType.CORRUPTED).toBe('CORRUPTED');
      expect(PDFErrorType.INVALID_FORMAT).toBe('INVALID_FORMAT');
      expect(PDFErrorType.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
      expect(PDFErrorType.READ_ERROR).toBe('READ_ERROR');
    });
  });

  describe('ExtractionResult interface', () => {
    it('should create a successful extraction result', () => {
      const result: ExtractionResult = {
        success: true,
        text: 'Sample text',
        paragraphs: ['Paragraph 1', 'Paragraph 2'],
        metadata: {
          fileName: 'test.pdf',
          pageCount: 2,
          timestamp: new Date()
        }
      };

      expect(result.success).toBe(true);
      expect(result.text).toBe('Sample text');
      expect(result.paragraphs).toHaveLength(2);
      expect(result.metadata.fileName).toBe('test.pdf');
    });

    it('should create a failed extraction result', () => {
      const result: ExtractionResult = {
        success: false,
        error: 'File is password protected',
        metadata: {
          fileName: 'protected.pdf',
          pageCount: 0,
          timestamp: new Date()
        }
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('File is password protected');
      expect(result.text).toBeUndefined();
    });
  });

  describe('ProcessingReport interface', () => {
    it('should create a processing report', () => {
      const report: ProcessingReport = {
        totalFiles: 5,
        successCount: 3,
        failedCount: 2,
        processedFiles: ['file1.pdf', 'file2.pdf', 'file3.pdf'],
        failedFiles: [
          { fileName: 'file4.pdf', error: 'Corrupted' },
          { fileName: 'file5.pdf', error: 'Password protected' }
        ]
      };

      expect(report.totalFiles).toBe(5);
      expect(report.successCount).toBe(3);
      expect(report.failedCount).toBe(2);
      expect(report.processedFiles).toHaveLength(3);
      expect(report.failedFiles).toHaveLength(2);
    });
  });

  describe('PDFProcessingError class', () => {
    it('should create a PDF processing error', () => {
      const error = new PDFProcessingError(
        'Failed to read PDF',
        'test.pdf',
        false,
        PDFErrorType.CORRUPTED
      );

      expect(error.message).toBe('Failed to read PDF');
      expect(error.fileName).toBe('test.pdf');
      expect(error.isRecoverable).toBe(false);
      expect(error.errorType).toBe(PDFErrorType.CORRUPTED);
      expect(error.name).toBe('PDFProcessingError');
      expect(error instanceof Error).toBe(true);
      expect(error instanceof PDFProcessingError).toBe(true);
    });

    it('should create a recoverable error', () => {
      const error = new PDFProcessingError(
        'Temporary read error',
        'test.pdf',
        true,
        PDFErrorType.READ_ERROR
      );

      expect(error.isRecoverable).toBe(true);
      expect(error.errorType).toBe(PDFErrorType.READ_ERROR);
    });
  });

  describe('PDFProcessor interface', () => {
    it('should define all required methods', () => {
      // This test verifies that the interface can be implemented
      const mockProcessor: PDFProcessor = {
        initialize: jest.fn().mockResolvedValue(undefined),
        scanFolder: jest.fn().mockResolvedValue([]),
        extractText: jest.fn().mockResolvedValue({
          success: true,
          text: 'test',
          metadata: {
            fileName: 'test.pdf',
            pageCount: 1,
            timestamp: new Date()
          }
        }),
        moveProcessedFile: jest.fn().mockResolvedValue(undefined),
        processAll: jest.fn().mockResolvedValue({
          totalFiles: 0,
          successCount: 0,
          failedCount: 0,
          processedFiles: [],
          failedFiles: []
        })
      };

      expect(mockProcessor.initialize).toBeDefined();
      expect(mockProcessor.scanFolder).toBeDefined();
      expect(mockProcessor.extractText).toBeDefined();
      expect(mockProcessor.moveProcessedFile).toBeDefined();
      expect(mockProcessor.processAll).toBeDefined();
    });
  });
});
