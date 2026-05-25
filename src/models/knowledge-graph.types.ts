/**
 * Knowledge Graph Builder Types and Interfaces
 * 
 * This file defines the interfaces and types for the Knowledge Graph Builder component,
 * which is responsible for constructing and maintaining the knowledge graph in Neo4j.
 * 
 * Requirements: 5.1, 5.2, 5.3
 */

import { Entity, Relationship } from './genkit.types';
import { Neo4jConfig } from '../config/types';
import { ComparisonReport } from '../services/comparison';

/**
 * Interface for the Knowledge Graph Builder component
 * 
 * Responsible for building and maintaining the knowledge graph in Neo4j,
 * including nodes, relationships, and vector search capabilities.
 */
export interface KnowledgeGraphBuilder {
  /**
   * Connects to the Neo4j database
   * @param config - Neo4j connection configuration
   * @throws {Neo4jError} If connection fails
   */
  connect(config: Neo4jConfig): Promise<void>;

  /**
   * Creates or updates an entity node in the graph
   * @param entity - The entity to create or update
   * @param sourceDocument - The source document filename
   * @param embeddings - Vector embeddings for the entity
   * @returns The node ID (UUID)
   * @throws {Neo4jError} If operation fails
   */
  createOrUpdateEntity(
    entity: Entity,
    sourceDocument: string,
    embeddings: number[]
  ): Promise<string>;

  /**
   * Creates a relationship between two entities
   * @param relationship - The relationship to create
   * @param sourceDocument - The source document filename
   * @throws {Neo4jError} If operation fails
   */
  createRelationship(
    relationship: Relationship,
    sourceDocument: string
  ): Promise<void>;

  /**
   * Processes a complete analysis result, creating entities and relationships
   * @param result - The analysis result from Genkit Engine
   * @param sourceDocument - The source document filename
   * @returns Statistics about the graph operations
   * @throws {Neo4jError} If operation fails
   */
  processAnalysisResult(
    result: AnalysisResult,
    sourceDocument: string
  ): Promise<GraphStats>;

  /**
   * Executes a vector similarity search
   * @param queryEmbeddings - The query vector embeddings
   * @param limit - Maximum number of results to return
   * @returns Array of search results ordered by similarity
   * @throws {Neo4jError} If search fails
   */
  vectorSearch(
    queryEmbeddings: number[],
    limit: number
  ): Promise<SearchResult[]>;

  /**
   * Gets the context (neighbors) of a node
   * @param nodeId - The node ID to get context for
   * @param depth - How many levels of neighbors to retrieve
   * @returns The node context including neighbors
   * @throws {Neo4jError} If node not found or operation fails
   */
  getNodeContext(nodeId: string, depth: number): Promise<GraphContext>;

  /**
   * Saves a comparison report and its ontology into the knowledge graph
   * @param report - The comparison report to save
   * @throws {Neo4jError} If operation fails
   */
  saveComparisonReport(report: ComparisonReport): Promise<void>;

  /**
   * Clears previous comparison nodes from the graph
   */
  clearPreviousComparisons(): Promise<void>;

  /**
   * Clears the entire database (all nodes and relationships)
   */
  clearEntireDatabase(): Promise<void>;

  /**
   * Retrieves the latest comparison report from the graph
   */
  getLatestComparison(): Promise<ComparisonReport | null>;

  /**
   * Closes the connection to Neo4j
   */
  disconnect(): Promise<void>;
}

/**
 * Statistics about graph operations
 * 
 * Tracks the number of entities and relationships created or updated
 * during a graph building operation.
 */
export interface GraphStats {
  /** Number of new entities created */
  entitiesCreated: number;

  /** Number of existing entities updated */
  entitiesUpdated: number;

  /** Number of new relationships created */
  relationshipsCreated: number;
}

/**
 * Result from a vector similarity search
 * 
 * Contains information about a node found through vector search,
 * including its similarity score and source documents.
 */
export interface SearchResult {
  /** The unique node ID */
  nodeId: string;

  /** The entity information */
  entity: Entity;

  /** Similarity score (0-1, higher is more similar) */
  similarity: number;

  /** List of source document filenames */
  sourceDocuments: string[];
}

/**
 * Context information for a node
 * 
 * Includes the center node and its neighboring nodes with relationship information.
 */
export interface GraphContext {
  /** The center node entity */
  centerNode: Entity;

  /** Array of neighboring nodes with relationship details */
  neighbors: NeighborInfo[];
}

/**
 * Information about a neighboring node
 * 
 * Describes a node connected to another node, including the relationship
 * type and direction.
 */
export interface NeighborInfo {
  /** The neighboring entity */
  entity: Entity;

  /** The type of relationship (e.g., "WORKS_AT", "LOCATED_IN") */
  relationship: string;

  /** Direction of the relationship from the center node's perspective */
  direction: 'incoming' | 'outgoing';
}

/**
 * Analysis result from Genkit Engine
 * 
 * Contains entities, relationships, and embeddings extracted from text.
 * This is used as input to the Knowledge Graph Builder.
 */
export interface AnalysisResult {
  /** Entities identified in the text */
  entities: Entity[];

  /** Relationships between entities */
  relationships: Relationship[];

  /** Vector embeddings for the text */
  embeddings: number[];

  /** The original source text */
  sourceText: string;
}

/**
 * Neo4j node properties
 * 
 * Represents the properties stored in a Neo4j entity node.
 */
export interface Neo4jNodeProperties {
  /** Unique identifier (UUID) */
  id: string;

  /** Entity name */
  name: string;

  /** Entity type (PERSON, ORGANIZATION, etc.) */
  type: string;

  /** Source text where entity was found */
  sourceText: string;

  /** Vector embeddings for similarity search */
  embeddings: number[];

  /** List of source document filenames */
  documents: string[];

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Neo4j relationship properties
 * 
 * Represents the properties stored in a Neo4j relationship.
 */
export interface Neo4jRelationshipProperties {
  /** Relationship type (normalized verb) */
  type: string;

  /** Source document filename */
  sourceDocument: string;

  /** Confidence score (0-1) */
  confidence: number;

  /** Creation timestamp */
  createdAt: Date;
}

/**
 * Neo4j query result
 * 
 * Generic type for Neo4j query results.
 */
export interface Neo4jQueryResult<T = any> {
  /** The records returned by the query */
  records: Neo4jRecord<T>[];
}

/**
 * Neo4j record
 * 
 * Represents a single record from a Neo4j query result.
 */
export interface Neo4jRecord<T = any> {
  /** Gets a value from the record by key */
  get(key: string): T;

  /** Checks if the record has a key */
  has(key: string): boolean;

  /** Returns all keys in the record */
  keys: string[];
}

/**
 * Neo4j transaction options
 * 
 * Configuration options for Neo4j transactions.
 */
export interface Neo4jTransactionOptions {
  /** Transaction timeout in milliseconds */
  timeout?: number;

  /** Transaction metadata */
  metadata?: Record<string, any>;
}

/**
 * Vector index configuration
 * 
 * Configuration for Neo4j vector index used for similarity search.
 */
export interface VectorIndexConfig {
  /** Number of dimensions in the embedding vectors */
  dimensions: number;

  /** Similarity function to use (cosine, euclidean) */
  similarityFunction: 'cosine' | 'euclidean';

  /** Index name */
  indexName: string;
}
