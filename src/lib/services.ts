/**
 * Lazy singleton service initialization for Astro API routes.
 * 
 * Replaces the Express server's createServerApp() initialization pattern.
 * Services are initialized once on first request and reused across all routes.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { ConfigurationManager } from '../config';
import { createLogger } from '../services/logger';
import { PDFProcessorImpl } from '../processors/pdf-processor';
import { GenkitEngineImpl } from '../services/genkit-engine';
import { KnowledgeGraphBuilderImpl } from '../services/knowledge-graph-builder';
import { VisualizationServiceImpl } from '../services/visualization';
import { ComparisonService } from '../services/comparison';
import { maybeSetOtelProviders } from '@google/adk';

const logger = createLogger();

// ── Initialize OpenTelemetry at module-load time ──
// Must run before any ADK InMemoryRunner/agent is created so traces export to LangSmith.
try {
  maybeSetOtelProviders();
  logger.info('Services', 'OpenTelemetry (OTel) instrumentation initialized at module level.');
} catch (err: any) {
  logger.warn('Services', `Failed to initialize OpenTelemetry: ${err.message}`);
}

// ── In-memory caches (module-level, persist across requests in same process) ──
export const correctedPdfs = new Map<string, Buffer>();
export const originalPdfBuffers = new Map<string, Buffer>();

// ── Disk-based PDF buffer persistence ──
// Survives dev-server hot-reloads that clear the in-memory Maps.
const PDF_CACHE_DIR = path.resolve(process.cwd(), '.pdf-cache');

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Persist an original PDF buffer to disk alongside the in-memory Map.
 */
export function savePdfBufferToDisk(name: string, buffer: Buffer): void {
  try {
    if (!fs.existsSync(PDF_CACHE_DIR)) {
      fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
    }
    const filePath = path.join(PDF_CACHE_DIR, sanitizeFilename(name));
    fs.writeFileSync(filePath, buffer);
    logger.info('PDFCache', `Persisted original PDF to disk: ${filePath} (${buffer.length} bytes)`);
  } catch (err: any) {
    logger.warn('PDFCache', `Failed to persist PDF to disk: ${err.message}`);
  }
}

/**
 * Retrieve a PDF buffer: first from in-memory Map, then from disk fallback.
 */
export function getOriginalPdfBuffer(name: string): Buffer | null {
  // Try in-memory first
  const memBuffer = originalPdfBuffers.get(name);
  if (memBuffer) return memBuffer;

  // Fall back to disk
  try {
    const filePath = path.join(PDF_CACHE_DIR, sanitizeFilename(name));
    if (fs.existsSync(filePath)) {
      const diskBuffer = fs.readFileSync(filePath);
      logger.info('PDFCache', `Recovered original PDF from disk: ${filePath} (${diskBuffer.length} bytes)`);
      // Re-populate in-memory cache
      originalPdfBuffers.set(name, diskBuffer);
      return diskBuffer;
    }
  } catch (err: any) {
    logger.warn('PDFCache', `Failed to read PDF from disk: ${err.message}`);
  }

  return null;
}

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
