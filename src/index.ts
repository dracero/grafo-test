/**
 * Main Entry Point for PDF Knowledge Graph System
 * 
 * Requirements: 15.1, 15.2
 */

import { startServer } from './server';

// Start the application with web server
if (require.main === module) {
  startServer().catch((error) => {
    console.error('Fatal error starting server:', error);
    process.exit(1);
  });
}
