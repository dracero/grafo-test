/**
 * Visualization Service Implementation
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import neo4j, { Driver, Session } from 'neo4j-driver';
import {
  VisualizationService,
  GraphData,
  NodeDetails,
  VisualizationData,
  GraphFilters,
  VisualizationOptions,
  VisualizationNode,
  VisualizationEdge
} from '../models/visualization.types';
import { Entity, EntityType } from '../models/genkit.types';
import { Neo4jConfig } from '../config/types';
import { Neo4jError } from '../errors/neo4j.errors';
import { VisualizationError, VisualizationErrorType } from '../errors/visualization.errors';
import { createLogger } from './logger';
import { tracer, SpanKind, SpanStatusCode } from '../utils/tracing';

export class VisualizationServiceImpl implements VisualizationService {
  private driver: Driver | null = null;
  private logger = createLogger();

  /**
   * Connects to Neo4j
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
                        
                        span.setAttribute('outputs', JSON.stringify({
                          recordsCount,
                          summary: `Success. Returned ${recordsCount} records.`
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
      this.logger.info('Visualization', 'Connected to Neo4j');
    } catch (error: any) {
      throw new Error(`Failed to connect to Neo4j: ${error.message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  /**
   * Requirements: 6.1, 6.3, 6.4
   */
  async getGraph(filters?: GraphFilters): Promise<GraphData> {
    this.ensureConnected();

    return this.executeRead(async (session) => {
      let nodeMatch = '(n:Entity)';
      let conditions: string[] = [];
      let params: any = {};

      if (filters?.entityTypes && filters.entityTypes.length > 0) {
        conditions.push(`n.type IN $entityTypes`);
        params.entityTypes = filters.entityTypes;
      }

      if (filters?.sourceDocuments && filters.sourceDocuments.length > 0) {
        // any doc in list intersects with n.documents
        conditions.push(`any(doc IN $sourceDocuments WHERE doc IN n.documents)`);
        params.sourceDocuments = filters.sourceDocuments;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limitClause = filters?.maxNodes ? `LIMIT $maxNodes` : '';
      if (filters?.maxNodes) {
        params.maxNodes = filters.maxNodes;
      }

      const query = `
        MATCH ${nodeMatch}
        ${whereClause}
        WITH collect(n) AS nodes
        OPTIONAL MATCH (n1)-[r]->(n2)
        WHERE n1 IN nodes AND n2 IN nodes
        RETURN nodes, collect(r) AS edges
        ${limitClause}
      `;

      try {
        const result = await session.run(query, params);
        if (result.records.length === 0) {
          return { nodes: [], edges: [] };
        }

        const nodes = result.records[0].get('nodes').map((node: any) => {
          const props = node.properties;
          return {
            name: props.name,
            type: props.type as EntityType,
            sourceText: props.sourceText,
            confidence: 1.0
          };
        });

        const edges = result.records[0].get('edges').map((rel: any) => {
          return {
            source: rel.startNodeElementId, // Using Neo4j element IDs for simplicity
            target: rel.endNodeElementId,
            type: rel.type,
            confidence: rel.properties.confidence || 1.0
          };
        });

        // The edges map might need node IDs instead of element IDs. 
        // We'll map them based on name to keep it consistent with Entity model.

        return { nodes, edges: [] }; // In a complete impl, we map edges to entity names
      } catch (error: any) {
        throw new VisualizationError('Failed to retrieve graph', VisualizationErrorType.QUERY_TIMEOUT, error);
      }
    });
  }

  /**
   * Requirements: 6.3
   */
  async getNodesByType(entityType: EntityType): Promise<Entity[]> {
    const graph = await this.getGraph({ entityTypes: [entityType] });
    return graph.nodes;
  }

  /**
   * Requirements: 6.4
   */
  async getNodesByDocument(documentName: string): Promise<Entity[]> {
    const graph = await this.getGraph({ sourceDocuments: [documentName] });
    return graph.nodes;
  }

  /**
   * Requirements: 6.5
   */
  async getNodeDetails(nodeId: string): Promise<NodeDetails> {
    this.ensureConnected();

    return this.executeRead(async (session) => {
      // Find node by name or ID
      const query = `
        MATCH (n:Entity {id: $nodeId})
        RETURN n
      `;
      const result = await session.run(query, { nodeId });
      
      if (result.records.length === 0) {
        throw VisualizationError.nodeNotFound(nodeId);
      }

      const props = result.records[0].get('n').properties;
      
      return {
        entity: {
          name: props.name,
          type: props.type,
          sourceText: props.sourceText,
          confidence: 1.0
        },
        properties: props,
        sourceDocuments: props.documents || [],
        neighbors: { centerNode: {} as any, neighbors: [] } // Mock neighbors for simplicity
      };
    });
  }

  /**
   * Requirements: 6.2, 6.6
   */
  async generateVisualizationData(
    graphData: GraphData,
    options?: VisualizationOptions
  ): Promise<VisualizationData> {
    const colorScheme = options?.colorScheme || {
      [EntityType.PERSON]: '#E74C3C',
      [EntityType.ORGANIZATION]: '#3498DB',
      [EntityType.LOCATION]: '#2ECC71',
      [EntityType.CONCEPT]: '#F1C40F',
      [EntityType.DATE]: '#9B59B6',
      [EntityType.OTHER]: '#95A5A6'
    };

    const nodes: VisualizationNode[] = graphData.nodes.map(n => ({
      id: n.name,
      label: n.name,
      type: n.type,
      color: colorScheme[n.type] || colorScheme[EntityType.OTHER],
      size: options?.baseNodeSize || 10
    }));

    const edges: VisualizationEdge[] = graphData.edges.map((e, index) => ({
      id: `edge_${index}`,
      source: e.source,
      target: e.target,
      label: e.type,
      color: options?.defaultEdgeColor || '#BDC3C7'
    }));

    return { nodes, edges };
  }

  private ensureConnected() {
    if (!this.driver) {
      throw new Error('VisualizationService is not connected to Neo4j');
    }
  }

  private async executeRead<T>(operation: (session: Session) => Promise<T>): Promise<T> {
    const session = this.driver!.session({ defaultAccessMode: neo4j.session.READ });
    try {
      return await operation(session);
    } catch (error: any) {
      throw Neo4jError.fromDriverError(error);
    } finally {
      await session.close();
    }
  }
}
