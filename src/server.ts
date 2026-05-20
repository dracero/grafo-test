/**
 * Express Web Server for PDF Knowledge Graph
 * 
 * Serves the interactive graph visualization frontend and
 * provides API endpoints for graph data retrieval and PDF processing.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
const pdfParse = require('pdf-parse');
import { ConfigurationManager } from './config';
import { createLogger } from './services/logger';
import { PDFProcessorImpl } from './processors/pdf-processor';
import { GenkitEngineImpl } from './services/genkit-engine';
import { KnowledgeGraphBuilderImpl } from './services/knowledge-graph-builder';
import { VisualizationServiceImpl } from './services/visualization';
import { ComparisonService } from './services/comparison';
import { EntityType } from './models/genkit.types';

const logger = createLogger();

export async function createServerApp() {
  logger.info('Server', 'Starting PDF Knowledge Graph Server');

  // 1. Initialize Configuration
  const configManager = new ConfigurationManager();
  configManager.load();

  for (const warning of configManager.getWarnings()) {
    logger.warn('Configuration', warning);
  }

  const validation = configManager.validate();
  if (!validation.isValid) {
    logger.error('Configuration', 'Configuration validation failed', new Error(validation.errors.join(', ')), {
      missingFields: validation.missingFields
    });
    process.exit(1);
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

  // Inject the Genkit engine so the graph builder can use the
  // genkitx-neo4j Agent Skills for vector indexing & retrieval.
  graphBuilder.setGenkitEngine(genkitEngine);

  const visualizationService = new VisualizationServiceImpl();
  await visualizationService.connect(config.neo4j);

  logger.info('Server', 'All services initialized successfully');

  // 3. Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static frontend files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ─── API Routes ───────────────────────────────────────────

  /**
   * GET /api/graph
   * Returns the full graph (nodes + edges) with optional filters.
   * Query params: entityTypes (comma-separated), sourceDocuments (comma-separated), maxNodes
   */
  app.get('/api/graph', async (req: Request, res: Response) => {
    try {
      const filters: any = {};

      if (req.query.entityTypes) {
        filters.entityTypes = (req.query.entityTypes as string).split(',');
      }
      if (req.query.sourceDocuments) {
        filters.sourceDocuments = (req.query.sourceDocuments as string).split(',');
      }
      if (req.query.maxNodes) {
        filters.maxNodes = parseInt(req.query.maxNodes as string, 10);
      }

      const graphData = await visualizationService.getGraph(filters);
      const vizData = await visualizationService.generateVisualizationData(graphData);

      res.json({
        success: true,
        data: vizData,
        stats: {
          nodeCount: vizData.nodes.length,
          edgeCount: vizData.edges.length
        }
      });
    } catch (error: any) {
      logger.error('API', 'Error fetching graph', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/graph/raw
   * Returns raw Neo4j graph data (all nodes and relationships)
   * directly via Cypher for maximum fidelity.
   */
  app.get('/api/graph/raw', async (req: Request, res: Response) => {
    try {
      const neo4jDriver = (visualizationService as any).driver;
      if (!neo4jDriver) {
        return res.status(500).json({ success: false, error: 'Neo4j not connected' });
      }

      const neo4jModule = await import('neo4j-driver');
      const session = neo4jDriver.session({ defaultAccessMode: neo4jModule.default.session.READ });

      try {
        // Get nodes that are part of the ontology or comparison
        const nodesResult = await session.run(`
          MATCH (n)
          WHERE n:NormativeDocument OR n:ProgramDocument OR n:OntologyItem
          RETURN n, labels(n) AS labels, elementId(n) AS elementId
        `);

        // Get relationships between those specific nodes
        const relsResult = await session.run(`
          MATCH (a)-[r]->(b)
          WHERE (a:NormativeDocument OR a:ProgramDocument OR a:OntologyItem)
            AND (b:NormativeDocument OR b:ProgramDocument OR b:OntologyItem)
          RETURN type(r) AS type, 
                 properties(r) AS props,
                 elementId(a) AS sourceId, 
                 elementId(b) AS targetId,
                 a.name AS sourceName,
                 b.name AS targetName
        `);

        const nodes = nodesResult.records.map((record: any) => {
          const node = record.get('n');
          const props = node.properties;
          return {
            id: props.name || props.id || record.get('elementId'),
            label: props.name || props.title || 'Unknown',
            type: props.type || record.get('labels')[0] || 'OTHER',
            properties: props,
            elementId: record.get('elementId')
          };
        });

        const edges = relsResult.records.map((record: any, index: number) => ({
          id: `edge_${index}`,
          source: record.get('sourceName') || record.get('sourceId'),
          target: record.get('targetName') || record.get('targetId'),
          label: record.get('type'),
          properties: record.get('props')
        }));

        res.json({
          success: true,
          data: { nodes, edges },
          stats: {
            nodeCount: nodes.length,
            edgeCount: edges.length
          }
        });
      } finally {
        await session.close();
      }
    } catch (error: any) {
      logger.error('API', 'Error fetching raw graph', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/node/:nodeId
   * Returns details for a specific node.
   */
  app.get('/api/node/:nodeId', async (req: Request, res: Response) => {
    try {
      const details = await visualizationService.getNodeDetails(req.params.nodeId as string);
      res.json({ success: true, data: details });
    } catch (error: any) {
      logger.error('API', `Error fetching node ${req.params.nodeId}`, error);
      res.status(404).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/stats
   * Returns graph statistics.
   */
  app.get('/api/stats', async (req: Request, res: Response) => {
    try {
      const neo4jDriver = (visualizationService as any).driver;
      if (!neo4jDriver) {
        return res.status(500).json({ success: false, error: 'Neo4j not connected' });
      }

      const neo4jModule = await import('neo4j-driver');
      const session = neo4jDriver.session({ defaultAccessMode: neo4jModule.default.session.READ });

      try {
        const nodeCount = await session.run('MATCH (n) RETURN count(n) AS count');
        const relCount = await session.run('MATCH ()-[r]->() RETURN count(r) AS count');
        const typeBreakdown = await session.run(`
          MATCH (n)
          WITH labels(n) AS lbls, COALESCE(n.type, labels(n)[0]) AS type
          RETURN type, count(*) AS count
          ORDER BY count DESC
        `);
        const docBreakdown = await session.run(`
          MATCH (n)
          WHERE n.documents IS NOT NULL
          UNWIND n.documents AS doc
          RETURN doc AS document, count(*) AS entityCount
          ORDER BY entityCount DESC
        `);

        res.json({
          success: true,
          data: {
            totalNodes: nodeCount.records[0].get('count'),
            totalRelationships: relCount.records[0].get('count'),
            typeBreakdown: typeBreakdown.records.map((r: any) => ({
              type: r.get('type'),
              count: r.get('count')
            })),
            documentBreakdown: docBreakdown.records.map((r: any) => ({
              document: r.get('document'),
              entityCount: r.get('entityCount')
            }))
          }
        });
      } finally {
        await session.close();
      }
    } catch (error: any) {
      logger.error('API', 'Error fetching stats', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/search
   * Vector similarity search. Body: { query: string, limit?: number }
   */
  app.post('/api/search', async (req: Request, res: Response) => {
    try {
      const { query, limit = 10 } = req.body;
      if (!query) {
        return res.status(400).json({ success: false, error: 'Query is required' });
      }

      // ── Uses genkitx-neo4j Agent Skills retriever (text-based) ──────────
      // This replaces the manual embedding → raw vectorSearch() flow.
      const results = await genkitEngine.retrieve(query, limit);

      res.json({ success: true, data: results });
    } catch (error: any) {
      logger.error('API', 'Error in vector search', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/process
   * Triggers PDF processing for all PDFs in the configured folder.
   */
  app.post('/api/process', async (req: Request, res: Response) => {
    try {
      logger.info('API', 'Starting PDF processing...');

      const files = await pdfProcessor.scanFolder();
      const results: any[] = [];

      for (const file of files) {
        try {
          const pdfResult = await pdfProcessor.extractText(file);
          if (!pdfResult.success || !pdfResult.text) {
            results.push({ file, status: 'error', error: pdfResult.error || 'No text extracted' });
            continue;
          }
          const analysis = await genkitEngine.analyzeText(pdfResult.text);
          const stats = await graphBuilder.processAnalysisResult(analysis, path.basename(file));
          results.push({ file: path.basename(file), status: 'success', stats });
        } catch (err: any) {
          results.push({ file: path.basename(file), status: 'error', error: err.message });
        }
      }

      res.json({ success: true, data: { processed: results.length, results } });
    } catch (error: any) {
      logger.error('API', 'Error processing PDFs', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/pdfs
   * Lists available PDFs in the configured folder.
   */
  app.get('/api/pdfs', async (req: Request, res: Response) => {
    try {
      const files = await pdfProcessor.scanFolder();
      res.json({ success: true, data: files.map((f: string) => path.basename(f)) });
    } catch (error: any) {
      logger.error('API', 'Error listing PDFs', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * DELETE /api/database/clear
   * Clears the entire Neo4j database (all nodes, relationships, constraints, and indexes).
   */
  app.delete('/api/database/clear', async (req: Request, res: Response) => {
    try {
      logger.warn('API', 'Clearing entire database - this action cannot be undone');

      const neo4jDriver = (visualizationService as any).driver;
      if (!neo4jDriver) {
        return res.status(500).json({ success: false, error: 'Neo4j not connected' });
      }

      const neo4jModule = await import('neo4j-driver');
      const session = neo4jDriver.session({ defaultAccessMode: neo4jModule.default.session.WRITE });

      try {
        // Count relationships and nodes before deleting
        const countResult = await session.run('MATCH (n) OPTIONAL MATCH (n)-[r]->() RETURN count(distinct n) as nodes, count(distinct r) as rels');
        const deletedNodes = countResult.records[0].get('nodes').toNumber();
        const deletedRels = countResult.records[0].get('rels').toNumber();

        // 1. Delete ALL nodes and relationships
        await session.run('MATCH (n) DETACH DELETE n');

        // 2. Drop all user-defined constraints
        let constraintNames: string[] = [];
        let deletedConstraints = 0;
        try {
          const constraintsResult = await session.run('SHOW CONSTRAINTS YIELD name RETURN name');
          constraintNames = constraintsResult.records.map((r: any) => r.get('name') as string);
          for (const name of constraintNames) {
            await session.run(`DROP CONSTRAINT \`${name}\` IF EXISTS`);
            deletedConstraints++;
          }
          logger.info('API', `Dropped ${deletedConstraints} constraints`);
        } catch (constraintErr: any) {
          logger.warn('API', `Could not drop constraints: ${constraintErr.message}`);
        }

        // 3. Drop all user-defined indexes (skip lookup indexes which are system indexes)
        let indexNames: string[] = [];
        let deletedIndexes = 0;
        try {
          const indexesResult = await session.run(
            `SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN name`
          );
          indexNames = indexesResult.records.map((r: any) => r.get('name') as string);
          for (const name of indexNames) {
            await session.run(`DROP INDEX \`${name}\` IF EXISTS`);
            deletedIndexes++;
          }
          logger.info('API', `Dropped ${deletedIndexes} indexes`);
        } catch (indexErr: any) {
          logger.warn('API', `Could not drop indexes: ${indexErr.message}`);
        }

        logger.info('API', `Database fully cleared: ${deletedNodes} nodes, ${deletedRels} relationships, ${deletedConstraints} constraints, ${deletedIndexes} indexes`);

        res.json({
          success: true,
          data: {
            deletedNodes,
            deletedRelationships: deletedRels,
            deletedConstraints,
            deletedIndexes,
            constraintNames,
            indexNames
          }
        });
      } finally {
        await session.close();
      }
    } catch (error: any) {
      logger.error('API', 'Error clearing database', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Comparison Routes ────────────────────────────────────
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
  const comparisonService = new ComparisonService(config.google.apiKey);

  /**
   * GET /api/compare/latest
   * Returns the latest comparison report from the graph, if any.
   */
  app.get('/api/compare/latest', async (req: Request, res: Response) => {
    try {
      const report = await graphBuilder.getLatestComparison();
      if (!report) {
        return res.json({ success: true, data: null });
      }
      res.json({ success: true, data: report });
    } catch (error: any) {
      logger.error('API', 'Error fetching latest comparison', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/compare', upload.fields([
    { name: 'normative', maxCount: 1 },
    { name: 'program', maxCount: 1 }
  ]), async (req: Request, res: Response) => {
    try {
      const files = (req as any).files as { [fieldname: string]: { buffer: Buffer; originalname: string }[] };
      if (!files?.normative?.[0] || !files?.program?.[0]) {
        return res.status(400).json({ success: false, error: 'Se requieren dos archivos: "normative" y "program"' });
      }

      const normFile = files.normative[0];
      const progFile = files.program[0];
      logger.info('Comparison', `Comparing: ${normFile.originalname} vs ${progFile.originalname}`);

      const normPdf = await pdfParse(normFile.buffer);
      const progPdf = await pdfParse(progFile.buffer);

      if (!normPdf.text?.trim()) return res.status(400).json({ success: false, error: 'No se pudo extraer texto del documento normativo' });
      if (!progPdf.text?.trim()) return res.status(400).json({ success: false, error: 'No se pudo extraer texto del programa' });

      const clearPrevious = req.body.clearPrevious === 'true';
      const report = await comparisonService.fullComparison(normPdf.text, progPdf.text, normFile.originalname, progFile.originalname);
      
      logger.info('API', `Comparison report generated: ${report.results.length} results, ${report.ontology.length} ontology items`);
      
      // Always attempt to persist — errors are logged but do NOT block the response
      try {
        if (clearPrevious) {
          await graphBuilder.clearPreviousComparisons();
          logger.info('API', 'Cleared previous comparisons from Neo4j');
        }

        // Save the generated ontology and comparison results into Neo4j
        logger.info('API', 'Starting to save comparison report to Neo4j...');
        await graphBuilder.saveComparisonReport(report);
        logger.info('API', 'Successfully saved comparison report to Neo4j');
      } catch (err: any) {
        // Log the persistence failure but still return the report to the user.
        // The comparison itself succeeded; persistence is best-effort.
        logger.error('API', 'Failed to save comparison to graph (non-fatal)', err);
      }

      res.json({ success: true, data: report });
    } catch (error: any) {
      logger.error('API', 'Error in comparison', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // SPA fallback — serve index.html for any non-API route
  app.get('/{*splat}', (req: Request, res: Response) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
  });

  return app;
}

// Global promise to cache the app initialization for Serverless environments
let appPromise: Promise<express.Express>;

export default async function handler(req: Request, res: Response) {
  if (!appPromise) {
    appPromise = createServerApp();
  }
  const app = await appPromise;
  return app(req, res);
}

export async function startServer() {
  const app = await createServerApp();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  app.listen(PORT, () => {
    logger.info('Server', `🚀 Web server running at http://localhost:${PORT}`);
    logger.info('Server', `📊 Open http://localhost:${PORT} in your browser to view the knowledge graph`);
  });
}
