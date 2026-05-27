/**
 * Lazy singleton service initialization for Astro API routes.
 * 
 * Replaces the Express server's createServerApp() initialization pattern.
 * Services are initialized once on first request and reused across all routes.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ConfigurationManager } from '../config';
import { createLogger } from '../services/logger';
import { PDFProcessorImpl } from '../processors/pdf-processor';
import { GenkitEngineImpl } from '../services/genkit-engine';
import { KnowledgeGraphBuilderImpl } from '../services/knowledge-graph-builder';
import { VisualizationServiceImpl } from '../services/visualization';
import { ComparisonService } from '../services/comparison';

const logger = createLogger();

// ── In-memory caches (module-level, persist across requests in same process) ──
export const correctedPdfs = new Map<string, Buffer>();
export const originalPdfBuffers = new Map<string, Buffer>();

// ── Services singleton ──
let servicesPromise: Promise<Services> | null = null;

export interface Services {
  config: ReturnType<ConfigurationManager['getConfig']>;
  pdfProcessor: PDFProcessorImpl;
  genkitEngine: GenkitEngineImpl;
  graphBuilder: KnowledgeGraphBuilderImpl;
  visualizationService: VisualizationServiceImpl;
  comparisonService: ComparisonService;
}

async function initializeServices(): Promise<Services> {
  logger.info('Services', 'Initializing services (lazy singleton)...');

  // 1. Configuration
  const configManager = new ConfigurationManager();
  configManager.load();

  for (const warning of configManager.getWarnings()) {
    logger.warn('Configuration', warning);
  }

  const validation = configManager.validate();
  if (!validation.isValid) {
    const errorMsg = `Configuration validation failed: ${validation.errors.join(', ')}`;
    logger.error('Configuration', errorMsg, new Error(errorMsg), {
      missingFields: validation.missingFields,
    });
    throw new Error(errorMsg);
  }

  logger.info('Configuration', 'Configuration loaded and validated successfully');
  const config = configManager.getConfig();

  // 2. Initialize services
  const pdfProcessor = new PDFProcessorImpl(config.pdfFolder.path);
  await pdfProcessor.initialize();
  logger.info('PDFProcessor', `Initialized with folder: ${config.pdfFolder.path}`);

  const genkitEngine = new GenkitEngineImpl();
  await genkitEngine.initialize(config.google);

  const graphBuilder = new KnowledgeGraphBuilderImpl();
  await graphBuilder.connect(config.neo4j);
  graphBuilder.setGenkitEngine(genkitEngine);

  const visualizationService = new VisualizationServiceImpl();
  await visualizationService.connect(config.neo4j);

  const comparisonService = new ComparisonService(config.google.apiKey);

  logger.info('Services', 'All services initialized successfully');

  return {
    config,
    pdfProcessor,
    genkitEngine,
    graphBuilder,
    visualizationService,
    comparisonService,
  };
}

/**
 * Get the initialized services singleton.
 * First call triggers initialization; subsequent calls return the cached promise.
 */
export function getServices(): Promise<Services> {
  if (!servicesPromise) {
    servicesPromise = initializeServices();
  }
  return servicesPromise;
}
