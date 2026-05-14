/**
 * Logger implementation for the PDF Knowledge Graph system
 * 
 * This module provides a concrete implementation of the Logger interface
 * with formatted output for different log levels.
 * 
 * Requirements: 8.1, 8.2, 8.6
 */

import { Logger, LogEntry, LogLevel } from '../types/logging';

/**
 * Console-based Logger implementation
 * 
 * Provides structured logging with timestamps, component identification,
 * and contextual information. Includes stack traces for error-level logs.
 */
export class ConsoleLogger implements Logger {
  /**
   * Log an error message with stack trace
   * 
   * @param component - The component or module generating the log
   * @param message - Human-readable error message
   * @param error - Error object containing stack trace
   * @param context - Optional contextual data
   */
  error(component: string, message: string, error: Error, context?: Record<string, any>): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.ERROR,
      component,
      message,
      context,
      stackTrace: error.stack
    };
    this.write(entry);
  }

  /**
   * Log a warning message
   * 
   * @param component - The component or module generating the log
   * @param message - Human-readable warning message
   * @param context - Optional contextual data
   */
  warn(component: string, message: string, context?: Record<string, any>): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.WARN,
      component,
      message,
      context
    };
    this.write(entry);
  }

  /**
   * Log an informational message
   * 
   * @param component - The component or module generating the log
   * @param message - Human-readable informational message
   * @param context - Optional contextual data
   */
  info(component: string, message: string, context?: Record<string, any>): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.INFO,
      component,
      message,
      context
    };
    this.write(entry);
  }

  /**
   * Log a debug message
   * 
   * @param component - The component or module generating the log
   * @param message - Human-readable debug message
   * @param context - Optional contextual data
   */
  debug(component: string, message: string, context?: Record<string, any>): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.DEBUG,
      component,
      message,
      context
    };
    this.write(entry);
  }

  /**
   * Write a log entry to the console with formatted output
   * 
   * Format: [TIMESTAMP] [LEVEL] [COMPONENT] Message
   * Includes context and stack trace when present
   * 
   * @param entry - The log entry to write
   */
  private write(entry: LogEntry): void {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.padEnd(5);
    const component = entry.component.padEnd(20);
    
    // Format the main log line
    const logLine = `[${timestamp}] [${level}] [${component}] ${entry.message}`;
    
    // Output to appropriate console method based on level
    switch (entry.level) {
      case LogLevel.ERROR:
        console.error(logLine);
        break;
      case LogLevel.WARN:
        console.warn(logLine);
        break;
      case LogLevel.INFO:
        console.info(logLine);
        break;
      case LogLevel.DEBUG:
        console.debug(logLine);
        break;
    }
    
    // Output context if present
    if (entry.context && Object.keys(entry.context).length > 0) {
      console.log('  Context:', JSON.stringify(entry.context, null, 2));
    }
    
    // Output stack trace if present (for errors)
    if (entry.stackTrace) {
      console.log('  Stack Trace:');
      console.log(entry.stackTrace.split('\n').map(line => `    ${line}`).join('\n'));
    }
  }
}

/**
 * Create a default logger instance
 * 
 * @returns A new ConsoleLogger instance
 */
export function createLogger(): Logger {
  return new ConsoleLogger();
}
