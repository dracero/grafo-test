/**
 * Logging types and interfaces for the PDF Knowledge Graph system
 * 
 * This module defines the core logging interfaces and types used throughout
 * the application for structured logging and error tracking.
 */

/**
 * Log levels enum
 * Defines the severity levels for log entries
 */
export enum LogLevel {
  /** Critical errors that prevent operation completion */
  ERROR = 'ERROR',
  /** Warning conditions that don't prevent execution */
  WARN = 'WARN',
  /** Important informational messages about system events */
  INFO = 'INFO',
  /** Detailed diagnostic information for debugging */
  DEBUG = 'DEBUG'
}

/**
 * Structure of a log entry
 * Contains all information needed to track and diagnose system events
 */
export interface LogEntry {
  /** Timestamp when the log entry was created */
  timestamp: Date;
  
  /** Severity level of the log entry */
  level: LogLevel;
  
  /** Component or module that generated the log entry */
  component: string;
  
  /** Human-readable log message */
  message: string;
  
  /** Optional contextual data (e.g., file names, IDs, configuration values) */
  context?: Record<string, any>;
  
  /** Stack trace for error entries (required for ERROR level) */
  stackTrace?: string;
}

/**
 * Logger interface
 * Defines methods for logging at different severity levels
 */
export interface Logger {
  /**
   * Log an error message with stack trace
   * Used for critical errors that prevent operation completion
   * 
   * @param component - The component or module generating the log
   * @param message - Human-readable error message
   * @param error - Error object containing stack trace
   * @param context - Optional contextual data
   */
  error(component: string, message: string, error: Error, context?: Record<string, any>): void;
  
  /**
   * Log a warning message
   * Used for anomalous situations that don't prevent execution
   * 
   * @param component - The component or module generating the log
   * @param message - Human-readable warning message
   * @param context - Optional contextual data
   */
  warn(component: string, message: string, context?: Record<string, any>): void;
  
  /**
   * Log an informational message
   * Used for important system events (startup, completion, statistics)
   * 
   * @param component - The component or module generating the log
   * @param message - Human-readable informational message
   * @param context - Optional contextual data
   */
  info(component: string, message: string, context?: Record<string, any>): void;
  
  /**
   * Log a debug message
   * Used for detailed diagnostic information
   * 
   * @param component - The component or module generating the log
   * @param message - Human-readable debug message
   * @param context - Optional contextual data
   */
  debug(component: string, message: string, context?: Record<string, any>): void;
}
