/**
 * PDF Processor Implementation
 * 
 * Implements PDF text extraction with paragraph preservation and error handling.
 * Validates Requirements 2.1, 2.2, 2.3, 2.4
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import pdfParse from 'pdf-parse';
import {
  PDFProcessor,
  ExtractionResult,
  ProcessingReport,
  ProcessingStatus,
  PDFProcessingError,
  PDFErrorType
} from '../models/pdf-processor.types';

export class PDFProcessorImpl implements PDFProcessor {
  private pdfFolderPath: string;
  private processedSubfolder: string;
  private failedSubfolder: string;

  constructor(pdfFolderPath: string) {
    this.pdfFolderPath = pdfFolderPath;
    this.processedSubfolder = path.join(pdfFolderPath, 'processed');
    this.failedSubfolder = path.join(pdfFolderPath, 'failed');
  }

  /**
   * Initializes the processor and verifies the PDF folder exists
   * Creates the folder and subfolders if they don't exist
   * Validates Requirements 1.2, 1.3
   */
  async initialize(): Promise<void> {
    try {
      // Check if main folder exists, create if not
      await fs.access(this.pdfFolderPath);
    } catch {
      try { await fs.mkdir(this.pdfFolderPath, { recursive: true }); } catch (e) { /* ignore read-only fs error */ }
    }

    // Create processed subfolder if it doesn't exist
    try {
      await fs.access(this.processedSubfolder);
    } catch {
      try { await fs.mkdir(this.processedSubfolder, { recursive: true }); } catch (e) { /* ignore */ }
    }

    // Create failed subfolder if it doesn't exist
    try {
      await fs.access(this.failedSubfolder);
    } catch {
      try { await fs.mkdir(this.failedSubfolder, { recursive: true }); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Scans the PDF folder and returns list of pending PDF files
   * Validates Requirements 1.4, 1.5
   */
  async scanFolder(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.pdfFolderPath);
      const pdfFiles = files
        .filter(file => file.toLowerCase().endsWith('.pdf'))
        .map(file => path.join(this.pdfFolderPath, file));
      
      // Filter out files that are actually in subfolders
      const mainFolderPdfs: string[] = [];
      for (const filePath of pdfFiles) {
        const stats = await fs.stat(filePath);
        if (stats.isFile()) {
          mainFolderPdfs.push(filePath);
        }
      }
      
      return mainFolderPdfs;
    } catch (error) {
      // Return empty array if folder does not exist or cannot be accessed
      return [];
    }
  }

  /**
   * Extracts text from a specific PDF file
   * Preserves paragraph structure and handles various error conditions
   * Validates Requirements 2.1, 2.2, 2.3, 2.4
   */
  async extractText(filePath: string): Promise<ExtractionResult> {
    const fileName = path.basename(filePath);
    const timestamp = new Date();

    try {
      // Read the PDF file
      const dataBuffer = await fs.readFile(filePath);
      
      // Parse the PDF
      let pdfData;
      try {
        pdfData = await pdfParse(dataBuffer);
      } catch (error: any) {
        // Check for specific error types
        if (error.message?.includes('password') || error.message?.includes('encrypted')) {
          throw new PDFProcessingError(
            `PDF is password protected: ${fileName}`,
            fileName,
            false,
            PDFErrorType.PASSWORD_PROTECTED
          );
        }
        
        if (error.message?.includes('corrupt') || error.message?.includes('invalid')) {
          throw new PDFProcessingError(
            `PDF is corrupted or invalid: ${fileName}`,
            fileName,
            false,
            PDFErrorType.CORRUPTED
          );
        }
        
        // Generic read error
        throw new PDFProcessingError(
          `Failed to read PDF: ${fileName} - ${error.message}`,
          fileName,
          true,
          PDFErrorType.READ_ERROR
        );
      }

      // Extract text
      const text = pdfData.text;
      
      // Preserve paragraph structure by analyzing line breaks
      // Split on double line breaks (paragraph separators) or single line breaks followed by significant whitespace
      const paragraphs = this.extractParagraphs(text);

      return {
        success: true,
        text,
        paragraphs,
        metadata: {
          fileName,
          pageCount: pdfData.numpages,
          timestamp
        }
      };

    } catch (error: any) {
      // If it's already a PDFProcessingError, rethrow it
      if (error instanceof PDFProcessingError) {
        return {
          success: false,
          error: error.message,
          metadata: {
            fileName,
            pageCount: 0,
            timestamp
          }
        };
      }

      // Handle permission errors
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return {
          success: false,
          error: `Permission denied reading file: ${fileName}`,
          metadata: {
            fileName,
            pageCount: 0,
            timestamp
          }
        };
      }

      // Handle file not found
      if (error.code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${fileName}`,
          metadata: {
            fileName,
            pageCount: 0,
            timestamp
          }
        };
      }

      // Generic error
      return {
        success: false,
        error: `Error processing PDF ${fileName}: ${error.message}`,
        metadata: {
          fileName,
          pageCount: 0,
          timestamp
        }
      };
    }
  }

  /**
   * Extracts paragraphs from text by analyzing line breaks
   * Preserves paragraph structure as per Requirement 2.2
   */
  private extractParagraphs(text: string): string[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    // Split on multiple line breaks (2 or more newlines)
    // This typically indicates paragraph boundaries
    const paragraphs = text
      .split(/\n\s*\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    // If no double line breaks found, try single line breaks
    // but only if the text is reasonably long
    if (paragraphs.length === 1 && text.length > 200) {
      const singleLineSplit = text
        .split(/\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
      
      // Group consecutive lines into paragraphs
      // A new paragraph starts when a line begins with capital letter after a period
      const groupedParagraphs: string[] = [];
      let currentParagraph = '';
      
      for (const line of singleLineSplit) {
        if (currentParagraph === '') {
          currentParagraph = line;
        } else if (this.isLikelyNewParagraph(line)) {
          groupedParagraphs.push(currentParagraph);
          currentParagraph = line;
        } else {
          currentParagraph += ' ' + line;
        }
      }
      
      if (currentParagraph) {
        groupedParagraphs.push(currentParagraph);
      }
      
      return groupedParagraphs.length > 1 ? groupedParagraphs : paragraphs;
    }

    return paragraphs;
  }

  /**
   * Heuristic to determine if a line likely starts a new paragraph
   */
  private isLikelyNewParagraph(line: string): boolean {
    // Check if line starts with capital letter and previous context suggests new paragraph
    // Common indicators: starts with capital, is not a continuation (no lowercase start)
    return /^[A-Z]/.test(line) && line.length > 20;
  }

  /**
   * Moves a processed file to the appropriate subfolder
   * Validates Requirements 9.3, 9.4
   */
  async moveProcessedFile(filePath: string, status: ProcessingStatus): Promise<void> {
    const fileName = path.basename(filePath);
    const targetFolder = status === ProcessingStatus.SUCCESS 
      ? this.processedSubfolder 
      : this.failedSubfolder;
    const targetPath = path.join(targetFolder, fileName);

    await fs.rename(filePath, targetPath);
  }

  /**
   * Processes all PDF files in the folder
   * Validates Requirements 9.1, 9.2, 9.5
   */
  async processAll(): Promise<ProcessingReport> {
    const pdfFiles = await this.scanFolder();
    const report: ProcessingReport = {
      totalFiles: pdfFiles.length,
      successCount: 0,
      failedCount: 0,
      processedFiles: [],
      failedFiles: []
    };

    // Process files sequentially to avoid memory overload
    for (const filePath of pdfFiles) {
      const result = await this.extractText(filePath);
      
      if (result.success) {
        report.successCount++;
        report.processedFiles.push(result.metadata.fileName);
        await this.moveProcessedFile(filePath, ProcessingStatus.SUCCESS);
      } else {
        report.failedCount++;
        report.failedFiles.push({
          fileName: result.metadata.fileName,
          error: result.error || 'Unknown error'
        });
        await this.moveProcessedFile(filePath, ProcessingStatus.FAILED);
      }
    }

    return report;
  }
}
