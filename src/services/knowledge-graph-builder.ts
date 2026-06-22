/**
 * Knowledge Graph Builder Implementation
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 7.2, 7.3, 7.4
 *
 * Architecture (hybrid):
 *  - Vector indexing & retrieval  → genkitx-neo4j Agent Skills (via GenkitEngineImpl)
 *  - Structured graph operations  → neo4j-driver (MERGE nodes/rels, Cypher queries)
 */

import neo4j, { Driver, Session } from 'neo4j-driver';
import { Document } from 'genkit';
import {
  KnowledgeGraphBuilder,
  GraphStats,
  SearchResult,
  GraphContext,
  AnalysisResult
} from '../models/knowledge-graph.types';
import { Entity, Relationship } from '../models/genkit.types';
import { Neo4jConfig } from '../config/types';
import { ComparisonReport } from './comparison';
import { Neo4jConnectionError, Neo4jQueryError, Neo4jError } from '../errors/neo4j.errors';
import { retryWithBackoff } from '../utils/retry';
import { createLogger } from './logger';
import { tracer, SpanKind, SpanStatusCode } from '../utils/tracing';
import { GenkitEngineImpl } from './genkit-engine';

export class KnowledgeGraphBuilderImpl implements KnowledgeGraphBuilder {
  private driver: Driver | null = null;
  private logger = createLogger();

  /**
   * The GenkitEngine is injected so we can call ai.index() / ai.retrieve()
   * (the Agent Skills) without duplicating Genkit initialisation.
   */
  private genkitEngine?: GenkitEngineImpl;

  /**
   * Injects the already-initialised GenkitEngine so this builder can use
   * the genkitx-neo4j Agent Skills for vector operations.
   */
  setGenkitEngine(engine: GenkitEngineImpl): void {
    this.genkitEngine = engine;
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  /**
   * Connects to Neo4j using the native driver.
   * The driver is kept only for structured Cypher operations (MERGE, relationships,
   * comparison reports, visualisation). Vector operations go through the plugin.
   * Requirements: 5.1, 5.4
   */
  async connect(config: Neo4jConfig): Promise<void> {
    try {
      const rawDriver = neo4j.driver(
        config.uri,
        neo4j.auth.basic(config.username, config.password),
        { disableLosslessIntegers: true }
      );

      // Create a proxy wrapper for the Driver object
      this.driver = new Proxy(rawDriver, {
        get(target: any, prop: string | symbol, receiver: any) {
          const originalValue = Reflect.get(target, prop, receiver);

          if (prop === 'session') {
            return function (...args: any[]) {
              const session = originalValue.apply(target, args);
              
              // Wrap the Session object to intercept the run method
              return new Proxy(session, {
                get(sTarget: any, sProp: string | symbol, sReceiver: any) {
                  const sOriginalValue = Reflect.get(sTarget, sProp, sReceiver);

                  if (sProp === 'run') {
                    return async function (query: string, parameters?: any) {
                      const startTime = Date.now();
                      const cleanedQuery = query.replace(/\s+/g, ' ').trim();
                      const querySummary = cleanedQuery.substring(0, 80);
                      
                      const span = tracer.startSpan(`Neo4j: ${querySummary}`, {
                        kind: SpanKind.CLIENT,
                        attributes: {
                          'langsmith.span.kind': 'tool',
                          'db.system': 'neo4j',
                          'db.statement': query,
                          'inputs': JSON.stringify({ query, parameters })
                        }
                      });
                      
                      try {
                        const result = await sOriginalValue.call(sTarget, query, parameters);
                        const duration = Date.now() - startTime;
                        const recordsCount = result.records ? result.records.length : 0;
                        // Sanitize parameters for logging: truncate large text values
                        const sanitizedParams = parameters ? Object.fromEntries(
                          Object.entries(parameters).map(([k, v]) => [
                            k,
                            typeof v === 'string' && (v as string).length > 100
                              ? (v as string).substring(0, 100) + `… [${(v as string).length} chars]`
                              : Array.isArray(v) && v.length > 5
                                ? `[Array(${v.length})]`
                                : v
                          ])
                        ) : undefined;
                        createLogger().info('Neo4jQuery', `✔ ${cleanedQuery.substring(0, 120)} | ${duration}ms | ${recordsCount} records`, sanitizedParams ? { params: sanitizedParams } : undefined);
                        
                        const simplifiedRecords = result.records ? result.records.map((record: any) => {
                          const obj: Record<string, any> = {};
                          record.keys.forEach((key: string) => {
                            const val = record.get(key);
                            if (typeof val === 'string' && val.length > 200) {
                              obj[key] = val.substring(0, 200) + '...';
                            } else if (val && typeof val === 'object' && val.properties) {
                              obj[key] = {
                                labels: val.labels,
                                properties: Object.fromEntries(
                                  Object.entries(val.properties).map(([k, v]) => [
                                    k,
                                    typeof v === 'string' && v.length > 100 ? v.substring(0, 100) + '...' : v
                                  ])
                                )
                              };
                            } else {
                              obj[key] = val;
                            }
                          });
                          return obj;
                        }) : [];

                        span.setAttribute('outputs', JSON.stringify({
                          recordsCount,
                          records: simplifiedRecords
                        }));
                        span.setStatus({ code: SpanStatusCode.OK });
                        return result;
                      } catch (error: any) {
                        const duration = Date.now() - startTime;
                        createLogger().error('Neo4jQuery', `✘ ${cleanedQuery.substring(0, 120)} | ${duration}ms | Error: ${error.message}`, error);
                        
                        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                        span.recordException(error);
                        throw error;
                      } finally {
                        span.end();
                      }
                    };
                  }
                  
                  return typeof sOriginalValue === 'function' 
                    ? sOriginalValue.bind(sTarget) 
                    : sOriginalValue;
                }
              });
            };
          }

          return typeof originalValue === 'function'
            ? originalValue.bind(target)
            : originalValue;
        }
      }) as unknown as Driver;

      await this.driver.verifyConnectivity();
      this.logger.info('KnowledgeGraph', 'Successfully connected to Neo4j');

      await this.initializeSchema();
    } catch (error: any) {
      this.logger.error('KnowledgeGraph', 'Failed to connect to Neo4j', error);
      throw new Neo4jConnectionError(`Connection failed: ${error.message}`);
    }
  }

  /**
   * Closes the Neo4j driver connection.
   */
  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.logger.info('KnowledgeGraph', 'Disconnected from Neo4j');
    }
  }

  // ─── Entity operations (Agent Skills) ─────────────────────────────────────

  /**
   * Creates or updates an entity node.
   *
   * Uses a hybrid approach:
   *   1. Writes the structured node (name, type, sourceText, documents) via
   *      Cypher MERGE so the graph relationships remain intact.
   *   2. Indexes the entity text through the genkitx-neo4j Agent Skill
   *      (`ai.index()`), which stores the embedding on the same :Entity node
   *      using the `embeddingProperty: 'embedding'` mapping configured in the plugin.
   *
   * Requirements: 5.2, 5.5, 5.6
   */
  async createOrUpdateEntity(entity: Entity, sourceDocument: string, embeddings: number[]): Promise<string> {
    this.ensureConnected();

    // 1. Structured MERGE via driver (keeps relationships / timestamps intact)
    const nodeId = await this.executeWrite(async (session) => {
      const query = `
        MERGE (e:Entity {name: $name})
        ON CREATE SET
          e.id = randomUUID(),
          e.type = $type,
          e.sourceText = $sourceText,
          e.documents = [$sourceDocument],
          e.createdAt = datetime(),
          e.updatedAt = datetime()
        ON MATCH SET
          e.type = $type,
          e.updatedAt = datetime()
        WITH e
        WHERE NOT $sourceDocument IN e.documents
        SET e.documents = e.documents + [$sourceDocument]
        RETURN e.id AS id
      `;

      const result = await session.run(query, {
        name: entity.name,
        type: entity.type,
        sourceText: entity.sourceText,
        sourceDocument,
      });

      return result.records[0]?.get('id') ?? entity.name;
    });

    // 2. Vector indexing via genkitx-neo4j Agent Skill ──────────────────────
    // The plugin maps `document.content[0].text` → `sourceText` property and
    // `document.metadata` is stored alongside. The embedding is generated by
    // the plugin's embedder OR pre-supplied via metadata.embedding.
    if (this.genkitEngine) {
      const doc = Document.fromText(entity.sourceText, {
        name: entity.name,
        type: entity.type,
        sourceDocument,
        // Attach pre-computed HuggingFace embedding so the plugin doesn't
        // need to call a Genkit-native embedder for this document.
        embedding: embeddings,
      });

      await this.genkitEngine.indexDocuments([doc]);
    } else {
      // Fallback: write embedding directly via driver if engine not injected
      await this.executeWrite(async (session) => {
        await session.run(
          `MATCH (e:Entity {name: $name}) SET e.embedding = $embeddings`,
          { name: entity.name, embeddings }
        );
      });
    }

    return nodeId;
  }

  // ─── Relationship operations (driver) ─────────────────────────────────────

  /**
   * Creates a relationship between two entities.
   * Remains a direct Cypher operation — the plugin has no relationship API.
   * Requirements: 5.3
   */
  async createRelationship(relationship: Relationship, sourceDocument: string): Promise<void> {
    this.ensureConnected();

    return this.executeWrite(async (session) => {
      const sanitizedType = relationship.type.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();

      const query = `
        MATCH (source:Entity {name: $sourceName})
        MATCH (target:Entity {name: $targetName})
        MERGE (source)-[r:${sanitizedType}]->(target)
        ON CREATE SET
          r.sourceDocument = $sourceDocument,
          r.confidence = $confidence,
          r.createdAt = datetime()
      `;

      await session.run(query, {
        sourceName: relationship.source,
        targetName: relationship.target,
        sourceDocument,
        confidence: relationship.confidence
      });
    });
  }

  // ─── Analysis result pipeline ──────────────────────────────────────────────

  /**
   * Processes a full analysis result.
   * Entity indexing uses the Agent Skill; relationship creation uses the driver.
   * Requirements: 5.7, 8.2
   */
  async processAnalysisResult(result: AnalysisResult, sourceDocument: string): Promise<GraphStats> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Processing analysis result for ${sourceDocument}`);

    let entitiesCreated = 0;
    let relationshipsCreated = 0;

    for (const entity of result.entities) {
      await this.createOrUpdateEntity(entity, sourceDocument, result.embeddings);
      entitiesCreated++;
    }

    for (const rel of result.relationships) {
      await this.createRelationship(rel, sourceDocument);
      relationshipsCreated++;
    }

    const stats: GraphStats = { entitiesCreated, entitiesUpdated: 0, relationshipsCreated };
    this.logger.info('KnowledgeGraph', 'Graph build complete', stats as any);
    return stats;
  }

  // ─── Vector search (Agent Skills) ─────────────────────────────────────────

  /**
   * Executes a semantic (vector) search against the Neo4j vector index.
   *
   * Uses the genkitx-neo4j retriever Agent Skill (`ai.retrieve()`) when the
   * engine is injected. Falls back to the direct Cypher `db.index.vector.queryNodes`
   * call if the engine is not available.
   *
   * Requirements: 7.2, 7.3, 7.4
   */
  async vectorSearch(queryEmbeddings: number[], limit: number): Promise<SearchResult[]> {
    // Preferred path: Agent Skills retriever
    if (this.genkitEngine) {
      // The retriever expects a text query. We pass a special marker so callers
      // that only have raw vectors can still go through this path.
      // If you have the original query text, prefer calling genkitEngine.retrieve() directly.
      this.logger.warn(
        'KnowledgeGraph',
        'vectorSearch called with raw embeddings — Agent Skills retriever needs text query. ' +
        'Prefer calling genkitEngine.retrieve(queryText, limit) directly from the API layer.'
      );
    }

    // Fallback: direct Cypher (works even without the engine)
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const query = `
        CALL db.index.vector.queryNodes('entity_embeddings', $limit, $embedding)
        YIELD node, score
        RETURN node.id AS id,
               node.name AS name,
               node.type AS type,
               node.sourceText AS sourceText,
               node.documents AS documents,
               score
        ORDER BY score DESC
      `;

      const result = await session.run(query, {
        embedding: queryEmbeddings,
        limit
      });

      return result.records.map(record => ({
        nodeId: record.get('id'),
        entity: {
          name: record.get('name'),
          type: record.get('type') as any,
          sourceText: record.get('sourceText'),
          confidence: 1.0
        },
        similarity: record.get('score'),
        sourceDocuments: record.get('documents')
      }));
    });
  }

  // ─── Node context (driver) ─────────────────────────────────────────────────

  /**
   * Retrieves context for a node.
   * Requirements: 7.4
   */
  async getNodeContext(nodeId: string, depth: number): Promise<GraphContext> {
    this.ensureConnected();

    return this.executeRead(async (session) => {
      const query = `
        MATCH (center:Entity {id: $nodeId})
        OPTIONAL MATCH (center)-[r]-(neighbor:Entity)
        RETURN center, type(r) as relType, startNode(r) = center as isOutgoing, neighbor
      `;

      const result = await session.run(query, { nodeId });

      if (result.records.length === 0) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      const centerProps = result.records[0].get('center').properties;
      const centerNode: Entity = {
        name: centerProps.name,
        type: centerProps.type as any,
        sourceText: centerProps.sourceText,
        confidence: 1.0
      };

      const neighbors = result.records
        .filter(record => record.get('neighbor') !== null)
        .map(record => {
          const neighborProps = record.get('neighbor').properties;
          return {
            entity: {
              name: neighborProps.name,
              type: neighborProps.type as any,
              sourceText: neighborProps.sourceText,
              confidence: 1.0
            },
            relationship: record.get('relType'),
            direction: record.get('isOutgoing') ? 'outgoing' : 'incoming' as 'incoming' | 'outgoing'
          };
        });

      return { centerNode, neighbors };
    });
  }

  // ─── Comparison reports (driver) ───────────────────────────────────────────

  /**
   * Saves a Comparison Report to Neo4j.
   * Structural graph writes — handled entirely via Cypher/driver.
   */
  async saveComparisonReport(report: ComparisonReport, userEmail: string): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Saving comparison report for ${report.programDocument} against ${report.normativeDocument} for user ${userEmail}`);

    return this.executeWrite(async (session) => {
      // Clean up previous EVALUATED_AGAINST relationships and program-specific OntologyItem nodes for this comparison to prevent accumulation
      await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument {name: $programName})
        OPTIONAL MATCH (p)-[r:EVALUATED_AGAINST]->(o:OntologyItem)
        DELETE r
      `, { userEmail, programName: report.programDocument });

      await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(n:NormativeDocument {name: $normativeName})
        OPTIONAL MATCH (o:OntologyItem)-[r:EXTRACTED_FROM]->(n)
        DETACH DELETE o
      `, { userEmail, normativeName: report.normativeDocument });

      await session.run(`
        MERGE (u:User {email: $userEmail})
        MERGE (d:Entity {name: $name})
        ON CREATE SET d.createdAt = datetime(), d.type = 'DOCUMENT', d.text = $text
        ON MATCH SET d.text = $text
        SET d:Document:NormativeDocument
        MERGE (u)-[:OWNED_BY]->(d)
      `, { userEmail, name: report.normativeDocument, text: report.normativeText || '' });

      await session.run(`
        MERGE (u:User {email: $userEmail})
        MERGE (d:Entity {name: $name})
        ON CREATE SET
          d.createdAt = datetime(),
          d.type = 'DOCUMENT',
          d.text = $text,
          d.total = $total,
          d.covered = $covered,
          d.partial = $partial,
          d.missing = $missing,
          d.coveragePercent = $coveragePercent
        ON MATCH SET
          d.text = $text,
          d.total = $total,
          d.covered = $covered,
          d.partial = $partial,
          d.missing = $missing,
          d.coveragePercent = $coveragePercent
        SET d:Document:ProgramDocument
        MERGE (u)-[:OWNED_BY]->(d)
        WITH d
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(n:Entity {name: $normativeDocument})
        WHERE n:NormativeDocument
        MERGE (d)-[:COMPARED_TO]->(n)
      `, {
        userEmail,
        name: report.programDocument,
        text: report.programText || '',
        total: report.summary.total,
        covered: report.summary.covered,
        partial: report.summary.partial,
        missing: report.summary.missing,
        coveragePercent: report.summary.coveragePercent,
        normativeDocument: report.normativeDocument
      });

      for (const item of report.ontology) {
        const uniqueName = `${report.normativeDocument}_${item.id}`;
        await session.run(`
          MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d:Entity {name: $docName})
          WHERE d:NormativeDocument
          MERGE (o:Entity {name: $uniqueName})
          ON CREATE SET
            o.id = $itemId,
            o.requirement = $requirement,
            o.category = $category,
            o.description = $description,
            o.keywords = $keywords,
            o.type = 'CONCEPT',
            o.sourceText = $description,
            o.createdAt = datetime()
          ON MATCH SET
            o.requirement = $requirement,
            o.category = $category,
            o.description = $description,
            o.keywords = $keywords,
            o.sourceText = $description
          SET o:OntologyItem
          MERGE (o)-[:EXTRACTED_FROM]->(d)
        `, {
          userEmail,
          docName: report.normativeDocument,
          uniqueName,
          itemId: item.id,
          requirement: item.requirement,
          category: item.category,
          description: item.description,
          keywords: item.keywords || []
        });
      }

      if (report.programOntology) {
        for (const item of report.programOntology) {
          await session.run(`
            MERGE (e:Entity {name: $name})
            ON CREATE SET
              e.id = randomUUID(),
              e.type = $type,
              e.sourceText = $sourceText,
              e.documents = [$sourceDocument],
              e.createdAt = datetime(),
              e.updatedAt = datetime()
            ON MATCH SET
              e.type = $type,
              e.updatedAt = datetime()
            WITH e
            WHERE NOT $sourceDocument IN e.documents
            SET e.documents = e.documents + [$sourceDocument]
          `, {
            name: item.requirement || item.description || item.id,
            type: item.category || 'CONCEPT',
            sourceText: item.description || item.requirement || '',
            sourceDocument: report.programDocument
          });
        }
      }

      for (const res of report.results) {
        const uniqueName = `${report.normativeDocument}_${res.item.id}`;
        await session.run(`
          MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:Entity {name: $progName})
          WHERE p:ProgramDocument
          MATCH (u)-[:OWNED_BY]->(:NormativeDocument)-[:EXTRACTED_FROM]-(o:Entity {name: $uniqueName})
          WHERE o:OntologyItem
          MERGE (p)-[r:EVALUATED_AGAINST]->(o)
          SET r.status = $status,
          r.confidence = $confidence,
          r.evidence = $evidence,
          r.suggestion = $suggestion,
          r.updatedAt = datetime()
        `, {
          userEmail,
          progName: report.programDocument,
          uniqueName,
          status: res.status,
          confidence: res.confidence,
          evidence: res.evidence,
          suggestion: res.suggestion
        });
      }
    });
  }

  /**
   * Saves the corrections generated by the fixer agent to the ProgramDocument node.
   */
  async saveCorrections(programName: string, corrections: any[], correctedText: string, userEmail: string): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Saving corrections for program: ${programName} for user: ${userEmail}`);
    return this.executeWrite(async (session) => {
      await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument {name: $programName})
        SET p.correctionsJson = $correctionsJson,
            p.correctedText = $correctedText,
            p.updatedAt = datetime()
      `, {
        userEmail,
        programName,
        correctionsJson: JSON.stringify(corrections),
        correctedText
      });
    });
  }

  /**
   * Clears previous comparison nodes from the graph.
   */
  async clearPreviousComparisons(userEmail: string): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Clearing previous comparison nodes from graph for user ${userEmail}`);
    return this.executeWrite(async (session) => {
      await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d:Document)
        OPTIONAL MATCH (d)-[:EXTRACTED_FROM|COMPARED_TO|EVALUATED_AGAINST]-(x)
        DETACH DELETE d, x
      `, { userEmail });
    });
  }

  /**
   * Clears the entire database (all nodes and relationships).
   */
  async clearEntireDatabase(userEmail: string): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Clearing Neo4j database data for user ${userEmail}`);
    return this.executeWrite(async (session) => {
      await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(n)
        OPTIONAL MATCH (n)-[:EXTRACTED_FROM|COMPARED_TO|EVALUATED_AGAINST]-(x)
        DETACH DELETE n, x
      `, { userEmail });
    });
  }

  /**
   * Retrieves the latest comparison report from the graph.
   */
  async getLatestComparison(userEmail: string): Promise<ComparisonReport | null> {
    this.ensureConnected();

    return this.executeRead(async (session) => {
      const query = `
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument)-[:COMPARED_TO]->(n:NormativeDocument)
        WHERE (u)-[:OWNED_BY]->(n)
        WITH p, n ORDER BY p.createdAt DESC LIMIT 1
        OPTIONAL MATCH (p)-[r:EVALUATED_AGAINST]->(o:OntologyItem)
        RETURN
          p.name AS programName,
          p.total AS total,
          p.covered AS covered,
          p.partial AS partial,
          p.missing AS missing,
          p.coveragePercent AS coveragePercent,
          p.correctionsJson AS correctionsJson,
          p.correctedText AS correctedText,
          n.name AS normativeName,
          o.id AS itemId,
          o.requirement AS requirement,
          o.category AS category,
          o.description AS description,
          o.keywords AS keywords,
          r.status AS status,
          r.confidence AS confidence,
          r.evidence AS evidence,
          r.suggestion AS suggestion
        ORDER BY o.id
      `;
      const result = await session.run(query, { userEmail });

      if (result.records.length === 0) {
        return null;
      }

      const normativeDocument = result.records[0].get('normativeName');
      const programDocument = result.records[0].get('programName');
      const correctionsJson = result.records[0].get('correctionsJson') || null;
      const correctedText = result.records[0].get('correctedText') || null;

      const summary = {
        total: Number(result.records[0].get('total')) || 0,
        covered: Number(result.records[0].get('covered')) || 0,
        partial: Number(result.records[0].get('partial')) || 0,
        missing: Number(result.records[0].get('missing')) || 0,
        coveragePercent: Number(result.records[0].get('coveragePercent')) || 0
      };

      const ontologyMap = new Map<string, any>();
      const results: any[] = [];

      for (const record of result.records) {
        const id = record.get('itemId');

        if (id) {
          if (!ontologyMap.has(id)) {
            ontologyMap.set(id, {
              id,
              category: record.get('category'),
              requirement: record.get('requirement'),
              description: record.get('description'),
              keywords: record.get('keywords') || []
            });
          }

          results.push({
            item: ontologyMap.get(id),
            status: record.get('status'),
            confidence: record.get('confidence'),
            evidence: record.get('evidence'),
            suggestion: record.get('suggestion')
          });
        }
      }

      return {
        normativeDocument,
        programDocument,
        ontology: Array.from(ontologyMap.values()),
        results,
        summary,
        timestamp: new Date().toISOString(),
        correctionsJson,
        correctedText
      };
    });
  }

  async getNormativeOntology(normativeName: string, userEmail: string): Promise<any[]> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const result = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d:NormativeDocument {name: $normativeName})<-[:EXTRACTED_FROM]-(o:OntologyItem)
        RETURN o.id AS id, o.category AS category, o.requirement AS requirement, o.description AS description, o.keywords AS keywords
        ORDER BY o.id
      `, { normativeName, userEmail });
      return result.records.map(record => ({
        id: record.get('id'),
        category: record.get('category'),
        requirement: record.get('requirement'),
        description: record.get('description'),
        keywords: record.get('keywords') || []
      }));
    });
  }

  async getProgramOntology(programName: string, userEmail: string): Promise<any[]> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const result = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument {name: $programName})
        WITH p
        MATCH (e:Entity)
        WHERE p.name IN e.documents AND e.type <> 'DOCUMENT' AND NOT e:OntologyItem
        RETURN e.name AS name, e.type AS type, e.sourceText AS sourceText
      `, { programName, userEmail });
      return result.records.map(record => ({
        name: record.get('name'),
        type: record.get('type'),
        sourceText: record.get('sourceText')
      }));
    });
  }

  async getComplianceGaps(normativeName: string, programName: string, userEmail: string): Promise<any[]> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const result = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument {name: $programName})-[r:EVALUATED_AGAINST]->(o:OntologyItem)
        WHERE r.status IN ['partial', 'missing'] AND (u)-[:OWNED_BY]->(:NormativeDocument)-[:EXTRACTED_FROM]-(o)
        RETURN o.id AS id, o.category AS category, o.requirement AS requirement, o.description AS description, r.status AS status, r.evidence AS evidence, r.suggestion AS suggestion
      `, { programName, userEmail });
      return result.records.map(record => ({
        id: record.get('id'),
        category: record.get('category'),
        requirement: record.get('requirement'),
        description: record.get('description'),
        status: record.get('status'),
        evidence: record.get('evidence'),
        suggestion: record.get('suggestion')
      }));
    });
  }

  async getProgramText(programName: string, userEmail: string): Promise<string> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const result = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument {name: $programName})
        RETURN p.text AS text
      `, { programName, userEmail });
      return result.records[0]?.get('text') || '';
    });
  }

  async saveRubric(rubric: any, pdfBase64: string, lang: string = 'es', userEmail: string): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Saving rubric to Neo4j with language: ${lang} for user: ${userEmail}...`);
    
    // Convert rubric to JSON string to preserve the full structure inside Neo4j node properties
    const rubricJson = JSON.stringify(rubric);
    
    return this.executeWrite(async (session) => {
      // First delete any previous rubric for this language and user
      await session.run('MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(r:Rubric {lang: $lang}) DETACH DELETE r', { userEmail, lang });
      
      // Store the new rubric as a single node and link it to the user
      await session.run(`
        MERGE (u:User {email: $userEmail})
        CREATE (r:Rubric {
          title: $title,
          subtitle: $subtitle,
          normativeDocument: $normativeDocument,
          rubricJson: $rubricJson,
          pdfBase64: $pdfBase64,
          generatedAt: $generatedAt,
          lang: $lang
        })
        CREATE (u)-[:OWNED_BY]->(r)
      `, {
        userEmail,
        title: rubric.title,
        subtitle: rubric.subtitle,
        normativeDocument: rubric.normativeDocument,
        rubricJson,
        pdfBase64,
        generatedAt: rubric.generatedAt,
        lang
      });
    });
  }

  async getLatestRubric(lang: string = 'es', userEmail: string): Promise<{ rubric: any; pdfBase64: string } | null> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Fetching latest rubric for language ${lang} and user ${userEmail} from Neo4j...`);
    return this.executeRead(async (session) => {
      const result = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(r:Rubric {lang: $lang})
        RETURN r.rubricJson AS rubricJson, r.pdfBase64 AS pdfBase64
        ORDER BY r.generatedAt DESC
        LIMIT 1
      `, { userEmail, lang });
      
      if (result.records.length === 0) {
        return null;
      }
      
      const rubricJson = result.records[0].get('rubricJson');
      const pdfBase64 = result.records[0].get('pdfBase64');
      
      try {
        const rubric = JSON.parse(rubricJson);
        return { rubric, pdfBase64 };
      } catch (err) {
        this.logger.error('KnowledgeGraph', `Failed to parse stored rubric JSON for language ${lang}`, err as Error);
        return null;
      }
    });
  }

  async clearRubrics(userEmail: string): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Clearing rubrics from Neo4j for user ${userEmail}`);
    return this.executeWrite(async (session) => {
      await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(n)
        WHERE n:Rubric OR n:GuideExample OR n:StructureSection OR n:EvaluableAspect
        DETACH DELETE n
      `, { userEmail });
    });
  }

  // ─── Guide Example & Evaluation Schema (Multi-Agent Rubric) ────────────────

  /**
   * Saves a guide example document with its detected structure sections.
   * Creates a :GuideExample node and child :StructureSection nodes.
   */
  async saveGuideExample(name: string, text: string, sections: Array<{ title: string; content: string }>): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Saving guide example: ${name} (${sections.length} sections)`);

    return this.executeWrite(async (session) => {
      // Remove previous guide examples
      await session.run('MATCH (g:GuideExample) DETACH DELETE g');
      await session.run('MATCH (s:StructureSection) DETACH DELETE s');

      // Create the guide example node
      await session.run(`
        CREATE (g:GuideExample {
          name: $name,
          text: $text,
          sectionCount: $sectionCount,
          createdAt: datetime()
        })
      `, { name, text, sectionCount: sections.length });

      // Create section nodes linked to the guide
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        await session.run(`
          MATCH (g:GuideExample {name: $guideName})
          CREATE (s:StructureSection {
            title: $title,
            content: $content,
            order: $order,
            createdAt: datetime()
          })
          CREATE (s)-[:SECTION_OF]->(g)
        `, {
          guideName: name,
          title: s.title,
          content: s.content,
          order: i + 1,
        });
      }
    });
  }

  /**
   * Saves an evaluation schema (aspects to evaluate) extracted from a PDF.
   * Creates :EvaluableAspect nodes linked to any matching :OntologyItem nodes.
   */
  async saveEvaluationSchema(name: string, aspects: Array<{ id: string; aspect: string; description: string; category: string }>, userEmail: string): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Saving evaluation schema: ${name} (${aspects.length} aspects) for user ${userEmail}`);

    return this.executeWrite(async (session) => {
      // Remove previous evaluation schema owned by the user
      await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(ea:EvaluableAspect)
        DETACH DELETE ea
      `, { userEmail });

      for (const a of aspects) {
        await session.run(`
          MATCH (u:User {email: $userEmail})
          CREATE (ea:EvaluableAspect {
            schemaName: $schemaName,
            aspectId: $aspectId,
            aspect: $aspect,
            description: $description,
            category: $category,
            createdAt: datetime()
          })
          CREATE (u)-[:OWNED_BY]->(ea)
        `, {
          userEmail,
          schemaName: name,
          aspectId: a.id,
          aspect: a.aspect,
          description: a.description,
          category: a.category,
        });
      }
    });
  }

  /**
   * Retrieves the guide example structure sections from Neo4j.
   */
  async getGuideStructure(name?: string): Promise<Array<{ title: string; content: string; order: number }>> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const query = name
        ? `MATCH (s:StructureSection)-[:SECTION_OF]->(g:GuideExample {name: $name}) RETURN s.title AS title, s.content AS content, s.order AS sOrder ORDER BY s.order`
        : `MATCH (s:StructureSection)-[:SECTION_OF]->(g:GuideExample) RETURN s.title AS title, s.content AS content, s.order AS sOrder ORDER BY s.order`;
      const result = await session.run(query, name ? { name } : {});
      return result.records.map(r => ({
        title: r.get('title'),
        content: r.get('content'),
        order: r.get('sOrder'),
      }));
    });
  }

  /**
   * Retrieves evaluation schema aspects from Neo4j.
   */
  async getEvaluationSchema(userEmail: string): Promise<Array<{ id: string; aspect: string; description: string; category: string }>> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const result = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(ea:EvaluableAspect)
        RETURN ea.aspectId AS id, ea.aspect AS aspect, ea.description AS description, ea.category AS category
        ORDER BY ea.aspectId
      `, { userEmail });
      return result.records.map(r => ({
        id: r.get('id'),
        aspect: r.get('aspect'),
        description: r.get('description'),
        category: r.get('category'),
      }));
    });
  }

  /**
   * Retrieves the raw text of the guide example.
   */
  async getGuideExampleText(): Promise<string> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const result = await session.run('MATCH (g:GuideExample) RETURN g.text AS text LIMIT 1');
      return result.records[0]?.get('text') || '';
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private ensureConnected() {
    if (!this.driver) {
      throw new Neo4jConnectionError('KnowledgeGraphBuilder is not connected to Neo4j');
    }
  }

  private async initializeSchema() {
    return this.executeWrite(async (session) => {
      await session.run(`
        CREATE CONSTRAINT entity_name_unique IF NOT EXISTS
        FOR (e:Entity) REQUIRE e.name IS UNIQUE
      `);

      await session.run(`
        CREATE CONSTRAINT user_email_unique IF NOT EXISTS
        FOR (u:User) REQUIRE u.email IS UNIQUE
      `);

      try {
        await session.run(`
          CREATE VECTOR INDEX entity_embeddings IF NOT EXISTS
          FOR (e:Entity)
          ON (e.embedding)
          OPTIONS {indexConfig: {
            \`vector.dimensions\`: 768,
            \`vector.similarity_function\`: 'cosine'
          }}
        `);
      } catch (e: any) {
        this.logger.warn('KnowledgeGraph', 'Could not create vector index (might not be supported on this Neo4j version)', { error: e.message });
      }
    });
  }

  private async executeWrite<T>(operation: (session: Session) => Promise<T>): Promise<T> {
    return retryWithBackoff(async () => {
      const session = this.driver!.session();
      try {
        return await operation(session);
      } catch (error: any) {
        throw Neo4jError.fromDriverError(error);
      } finally {
        await session.close();
      }
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      logger: this.logger,
      component: 'KnowledgeGraph'
    });
  }

  private async executeRead<T>(operation: (session: Session) => Promise<T>): Promise<T> {
    return retryWithBackoff(async () => {
      const session = this.driver!.session({ defaultAccessMode: neo4j.session.READ });
      try {
        return await operation(session);
      } catch (error: any) {
        throw Neo4jError.fromDriverError(error);
      } finally {
        await session.close();
      }
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      logger: this.logger,
      component: 'KnowledgeGraph'
    });
  }

  // ─── User Authentication Methods ──────────────────────────────────────────

  async getUserByEmail(email: string): Promise<any | null> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const result = await session.run(`
        MATCH (u:User {email: $email})
        RETURN u.email AS email, u.name AS name, u.passwordHash AS passwordHash, u.role AS role, u.isActive AS isActive, u.createdAt AS createdAt
      `, { email });
      if (result.records.length === 0) return null;
      const r = result.records[0];
      return {
        email: r.get('email'),
        name: r.get('name'),
        passwordHash: r.get('passwordHash'),
        role: r.get('role'),
        isActive: r.get('isActive'),
        createdAt: r.get('createdAt')
      };
    });
  }

  async createUser(user: { email: string; name: string; passwordHash: string; role: string; isActive: boolean }): Promise<void> {
    this.ensureConnected();
    return this.executeWrite(async (session) => {
      await session.run(`
        CREATE (u:User {
          email: $email,
          name: $name,
          passwordHash: $passwordHash,
          role: $role,
          isActive: $isActive,
          createdAt: datetime()
        })
      `, {
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        role: user.role,
        isActive: user.isActive
      });
    });
  }

  async hasAnyUser(): Promise<boolean> {
    this.ensureConnected();
    return this.executeRead(async (session) => {
      const result = await session.run(`
        MATCH (u:User)
        RETURN count(u) > 0 AS hasUsers
      `);
      return result.records[0]?.get('hasUsers') || false;
    });
  }
}
