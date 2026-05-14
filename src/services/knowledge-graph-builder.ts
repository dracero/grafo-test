/**
 * Knowledge Graph Builder Implementation
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 7.2, 7.3, 7.4, 8.2
 */

import neo4j, { Driver, Session } from 'neo4j-driver';
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

export class KnowledgeGraphBuilderImpl implements KnowledgeGraphBuilder {
  private driver: Driver | null = null;
  private logger = createLogger();

  /**
   * Connects to the Neo4j database and initializes schema
   * Requirements: 5.1, 5.4
   */
  async connect(config: Neo4jConfig): Promise<void> {
    try {
      this.driver = neo4j.driver(
        config.uri,
        neo4j.auth.basic(config.username, config.password),
        { disableLosslessIntegers: true } // Easier to work with standard JS numbers
      );

      // Verify connection
      await this.driver.verifyConnectivity();
      this.logger.info('KnowledgeGraph', 'Successfully connected to Neo4j');

      // Initialize schema (constraints and indexes)
      await this.initializeSchema();
    } catch (error: any) {
      this.logger.error('KnowledgeGraph', 'Failed to connect to Neo4j', error);
      throw new Neo4jConnectionError(`Connection failed: ${error.message}`);
    }
  }

  /**
   * Closes the Neo4j connection
   */
  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.logger.info('KnowledgeGraph', 'Disconnected from Neo4j');
    }
  }

  /**
   * Creates or updates an entity node
   * Requirements: 5.2, 5.5, 5.6
   */
  async createOrUpdateEntity(entity: Entity, sourceDocument: string, embeddings: number[]): Promise<string> {
    this.ensureConnected();

    return this.executeWrite(async (session) => {
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
        WITH e
        // We set the embedding in a separate step or via apoc if needed, 
        // but since Neo4j 5 we can just set it as a property
        SET e.embedding = $embeddings
        RETURN e.id AS id
      `;

      const result = await session.run(query, {
        name: entity.name,
        type: entity.type,
        sourceText: entity.sourceText,
        sourceDocument,
        embeddings
      });

      return result.records[0].get('id');
    });
  }

  /**
   * Creates a relationship between two entities
   * Requirements: 5.3
   */
  async createRelationship(relationship: Relationship, sourceDocument: string): Promise<void> {
    this.ensureConnected();

    return this.executeWrite(async (session) => {
      // Note: We use dynamic relationship types carefully by formatting the query
      // Neo4j driver parameters don't support dynamic relationship types natively
      // But for security, we must sanitize the relationship type
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

  /**
   * Processes a full analysis result
   * Requirements: 5.7, 8.2
   */
  async processAnalysisResult(result: AnalysisResult, sourceDocument: string): Promise<GraphStats> {
    this.ensureConnected();
    
    this.logger.info('KnowledgeGraph', `Processing analysis result for ${sourceDocument}`);

    let entitiesCreated = 0;
    let relationshipsCreated = 0;

    // We process in a single transaction if possible, or multiple if large.
    // For simplicity, we'll execute sequentially here using the helper methods.
    for (const entity of result.entities) {
      await this.createOrUpdateEntity(entity, sourceDocument, result.embeddings);
      entitiesCreated++;
    }

    for (const rel of result.relationships) {
      // Only create relationship if both entities exist in the graph
      // (The merge queries assume nodes are created or matched)
      await this.createRelationship(rel, sourceDocument);
      relationshipsCreated++;
    }

    const stats: GraphStats = {
      entitiesCreated,
      entitiesUpdated: 0, // In a more complex tracking we'd separate created/updated
      relationshipsCreated
    };

    this.logger.info('KnowledgeGraph', `Graph build complete`, stats as any);
    return stats;
  }

  /**
   * Executes a vector search
   * Requirements: 7.2, 7.3, 7.4
   */
  async vectorSearch(queryEmbeddings: number[], limit: number): Promise<SearchResult[]> {
    this.ensureConnected();

    return this.executeRead(async (session) => {
      // In Neo4j 5.0+, vector indexes are queried using db.index.vector.queryNodes
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
          confidence: 1.0 // Implicit for search
        },
        similarity: record.get('score'),
        sourceDocuments: record.get('documents')
      }));
    });
  }

  /**
   * Retrieves context for a node
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

      return {
        centerNode,
        neighbors
      };
    });
  }

  /**
   * Saves a Comparison Report to Neo4j
   */
  async saveComparisonReport(report: ComparisonReport): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', `Saving comparison report for ${report.programDocument} against ${report.normativeDocument}`);

    return this.executeWrite(async (session) => {
      // 1. Create the Normative Document Node
      await session.run(`
        MERGE (d:Entity:Document:NormativeDocument {name: $name})
        ON CREATE SET d.createdAt = datetime(), d.type = 'DOCUMENT'
      `, { name: report.normativeDocument });

      // 2. Create the Program Document Node
      await session.run(`
        MERGE (d:Entity:Document:ProgramDocument {name: $name})
        ON CREATE SET 
          d.createdAt = datetime(), 
          d.type = 'DOCUMENT',
          d.total = $total,
          d.covered = $covered,
          d.partial = $partial,
          d.missing = $missing,
          d.coveragePercent = $coveragePercent
        ON MATCH SET
          d.total = $total,
          d.covered = $covered,
          d.partial = $partial,
          d.missing = $missing,
          d.coveragePercent = $coveragePercent
        WITH d
        MATCH (n:NormativeDocument {name: $normativeDocument})
        MERGE (d)-[:COMPARED_TO]->(n)
      `, { 
        name: report.programDocument,
        total: report.summary.total,
        covered: report.summary.covered,
        partial: report.summary.partial,
        missing: report.summary.missing,
        coveragePercent: report.summary.coveragePercent,
        normativeDocument: report.normativeDocument
      });

      // 3. Create Ontology Items and Link to Normative Document
      for (const item of report.ontology) {
        const uniqueName = `${report.normativeDocument}_${item.id}`;
        await session.run(`
          MATCH (d:NormativeDocument {name: $docName})
          MERGE (o:Entity:OntologyItem {name: $uniqueName})
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
          MERGE (o)-[:EXTRACTED_FROM]->(d)
        `, {
          docName: report.normativeDocument,
          uniqueName,
          itemId: item.id,
          requirement: item.requirement,
          category: item.category,
          description: item.description,
          keywords: item.keywords
        });
      }

      // 4. Create Comparison Results linking Program to Ontology Items
      for (const res of report.results) {
        const uniqueName = `${report.normativeDocument}_${res.item.id}`;
        await session.run(`
          MATCH (p:ProgramDocument {name: $progName})
          MATCH (o:OntologyItem {name: $uniqueName})
          MERGE (p)-[r:EVALUATED_AGAINST]->(o)
          SET r.status = $status,
              r.confidence = $confidence,
              r.evidence = $evidence,
              r.suggestion = $suggestion,
              r.updatedAt = datetime()
        `, {
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
   * Clears previous comparison nodes from the graph
   */
  async clearPreviousComparisons(): Promise<void> {
    this.ensureConnected();
    this.logger.info('KnowledgeGraph', 'Clearing previous comparison nodes from graph');
    return this.executeWrite(async (session) => {
      await session.run(`
        MATCH (n)
        WHERE n:NormativeDocument OR n:ProgramDocument OR n:OntologyItem
        DETACH DELETE n
      `);
    });
  }

  /**
   * Retrieves the latest comparison report from the graph
   */
  async getLatestComparison(): Promise<ComparisonReport | null> {
    this.ensureConnected();

    return this.executeRead(async (session) => {
      const query = `
        MATCH (p:ProgramDocument)-[:COMPARED_TO]->(n:NormativeDocument)
        WITH p, n ORDER BY p.createdAt DESC LIMIT 1
        OPTIONAL MATCH (p)-[r:EVALUATED_AGAINST]->(o:OntologyItem)
        RETURN 
          p.name AS programName,
          p.total AS total,
          p.covered AS covered,
          p.partial AS partial,
          p.missing AS missing,
          p.coveragePercent AS coveragePercent,
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
      const result = await session.run(query);

      if (result.records.length === 0) {
        return null;
      }

      const normativeDocument = result.records[0].get('normativeName');
      const programDocument = result.records[0].get('programName');
      
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
        timestamp: new Date().toISOString()
      };
    });
  }

  // --- Private Helpers ---

  private ensureConnected() {
    if (!this.driver) {
      throw new Neo4jConnectionError('KnowledgeGraphBuilder is not connected to Neo4j');
    }
  }

  private async initializeSchema() {
    return this.executeWrite(async (session) => {
      // Create constraint on Entity name
      await session.run(`
        CREATE CONSTRAINT entity_name_unique IF NOT EXISTS
        FOR (e:Entity) REQUIRE e.name IS UNIQUE
      `);

      // Attempt to create vector index (requires Neo4j 5+)
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
}
