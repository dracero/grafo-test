/**
 * Genkit Engine Implementation
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 7.1
 *
 * Uses genkitx-neo4j Agent Skills plugin for vector store operations
 * (indexing and retrieval), replacing direct Neo4j driver calls for
 * those specific operations.
 */

import { genkit, Genkit, Document } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { groq } from 'genkitx-groq';
import { neo4j, neo4jIndexerRef, neo4jRetrieverRef } from 'genkitx-neo4j';
import { z } from 'zod';
import {
  GenkitEngine,
  AnalysisResult,
  GoogleConfig,
  EntityType
} from '../models/genkit.types';
import { SearchResult } from '../models/knowledge-graph.types';
import { GenkitAPIError } from '../errors/genkit.errors';
import { retryWithBackoff } from '../utils/retry';
import { createLogger } from './logger';

// ─── Neo4j Agent Skills: Index and Retriever references ──────────────────────

/**
 * The Neo4j vector index ID for entity embeddings.
 * Must match the index configured in the genkitx-neo4j plugin.
 */
const ENTITY_INDEX_ID = 'entity_embeddings';

/**
 * Indexer reference — used to store entity documents into Neo4j via
 * the genkitx-neo4j Agent Skill.
 */
export const entityIndexer = neo4jIndexerRef({
  indexId: ENTITY_INDEX_ID,
  displayName: 'Entity Knowledge Graph Indexer',
});

/**
 * Retriever reference — used to run vector similarity search against
 * the Neo4j vector index via the genkitx-neo4j Agent Skill.
 */
export const entityRetriever = neo4jRetrieverRef({
  indexId: ENTITY_INDEX_ID,
  displayName: 'Entity Knowledge Graph Retriever',
});

// ─── GenkitEngine ─────────────────────────────────────────────────────────────

export class GenkitEngineImpl implements GenkitEngine {
  private ai?: Genkit;
  private logger = createLogger();

  /**
   * Initializes Genkit with Google AI, Groq, and Neo4j Agent Skills plugins.
   * Requirements: 4.1
   */
  async initialize(config: GoogleConfig): Promise<void> {
    try {
      this.ai = genkit({
        plugins: [
          googleAI({ apiKey: config.apiKey }),
          groq({ apiKey: process.env.GROQ_API_KEY }),
          // ── Neo4j Agent Skills plugin ─────────────────────────────────────
          // Configures the genkitx-neo4j vector store. Connection details are
          // read from NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD env vars, or
          // can be passed explicitly via `clientParams`.
          neo4j([
            {
              indexId: ENTITY_INDEX_ID,
              embedder: undefined as any,
            },
          ]),
        ],
      });
      this.logger.info('GenkitEngine', 'Genkit initialized with Neo4j Agent Skills plugin');
    } catch (error: any) {
      this.logger.error('GenkitEngine', 'Failed to initialize Genkit', error);
      throw new Error(`Genkit initialization failed: ${error.message}`);
    }
  }

  /**
   * Returns the internal Genkit `ai` instance so that other services
   * (e.g. KnowledgeGraphBuilderImpl) can call ai.index() / ai.retrieve().
   */
  getAi(): Genkit {
    this.ensureInitialized();
    return this.ai!;
  }

  /**
   * Analyzes text to extract entities and relationships.
   * Requirements: 4.2, 4.3, 4.5
   */
  async analyzeText(text: string): Promise<AnalysisResult> {
    this.ensureInitialized();

    return retryWithBackoff(async () => {
      try {
        this.logger.debug('GenkitEngine', `Analyzing text of length ${text.length}`);

        const EntitySchema = z.object({
          name: z.string(),
          type: z.nativeEnum(EntityType),
          sourceText: z.string(),
          confidence: z.number().min(0).max(1)
        });

        const RelationshipSchema = z.object({
          source: z.string(),
          target: z.string(),
          type: z.string(),
          confidence: z.number().min(0).max(1)
        });

        const OutputSchema = z.object({
          entities: z.array(EntitySchema),
          relationships: z.array(RelationshipSchema)
        });

        const MAX_CHARS = 70000;
        const safeText = text.length > MAX_CHARS
          ? text.substring(0, MAX_CHARS) + '\n\n[TEXTO TRUNCADO POR LÍMITES DE API]'
          : text;

        const prompt = `Analyze the following text and extract key entities (people, organizations, locations, concepts, dates) and the relationships between them. Ensure that 'source' and 'target' in relationships precisely match the 'name' of the extracted entities. Normalize relationship types to clear, capitalized verbs (e.g., "WORKS_AT", "LOCATED_IN").\n\nText:\n${safeText}`;

        const response = await this.ai!.generate({
          model: 'googleai/gemini-2.5-flash',
          prompt: prompt,
          output: {
            format: 'json',
            schema: OutputSchema
          },
          config: { maxOutputTokens: 2048 }
        });

        const data = response.output;
        if (!data) {
          throw new Error('No data returned from model');
        }

        const embeddings = await this.generateEmbeddings(text);

        return {
          entities: data.entities,
          relationships: data.relationships,
          embeddings,
          sourceText: text
        };
      } catch (error: any) {
        const statusCode = error.status || error.code || 500;
        throw new GenkitAPIError(
          `Analysis failed: ${error.message}`,
          statusCode,
          GenkitAPIError.isRecoverableStatusCode(statusCode),
          { endpoint: 'generate', textLength: text.length, timestamp: new Date() }
        );
      }
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      logger: this.logger,
      component: 'GenkitEngine',
      operationName: 'analyzeText'
    });
  }

  /**
   * Indexes a set of entity documents into Neo4j using the Agent Skills plugin.
   * This replaces direct `session.run(MERGE ...)` calls for vector storage.
   * Requirements: 4.4, 5.2
   *
   * @param documents - Genkit Document objects whose content is the entity
   *   sourceText and whose metadata includes name, type, sourceDocument, etc.
   */
  async indexDocuments(documents: Document[]): Promise<void> {
    this.ensureInitialized();

    return retryWithBackoff(async () => {
      try {
        await this.ai!.index({
          indexer: entityIndexer,
          documents,
        });
        this.logger.info('GenkitEngine', `Indexed ${documents.length} documents into Neo4j`);
      } catch (error: any) {
        const statusCode = error.status || error.code || 500;
        throw new GenkitAPIError(
          `Indexing failed: ${error.message}`,
          statusCode,
          GenkitAPIError.isRecoverableStatusCode(statusCode),
          { endpoint: 'index', timestamp: new Date(), additionalInfo: { count: documents.length } }
        );
      }
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      logger: this.logger,
      component: 'GenkitEngine',
      operationName: 'indexDocuments'
    });
  }

  /**
   * Runs a vector similarity search using the Neo4j Agent Skills retriever.
   * This replaces `db.index.vector.queryNodes` Cypher calls.
   * Requirements: 7.2, 7.3, 7.4
   *
   * @param query  - The natural language query string
   * @param limit  - Maximum number of results to return
   */
  async retrieve(query: string, limit: number): Promise<SearchResult[]> {
    this.ensureInitialized();

    return retryWithBackoff(async () => {
      try {
        const docs = await this.ai!.retrieve({
          retriever: entityRetriever,
          query,
          options: { k: limit },
        });

        return docs.map((doc) => ({
          nodeId: doc.metadata?.name as string ?? '',
          entity: {
            name: doc.metadata?.name as string ?? '',
            type: (doc.metadata?.type as EntityType) ?? EntityType.OTHER,
            sourceText: doc.content[0]?.text ?? '',
            confidence: 1.0,
          },
          similarity: (doc.metadata?.score as number) ?? 1.0,
          sourceDocuments: (doc.metadata?.documents as string[]) ?? [],
        }));
      } catch (error: any) {
        const statusCode = error.status || error.code || 500;
        throw new GenkitAPIError(
          `Retrieval failed: ${error.message}`,
          statusCode,
          GenkitAPIError.isRecoverableStatusCode(statusCode),
          { endpoint: 'retrieve', timestamp: new Date(), additionalInfo: { query, limit } }
        );
      }
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      logger: this.logger,
      component: 'GenkitEngine',
      operationName: 'retrieve'
    });
  }

  /**
   * Generates vector embeddings for a text using HuggingFace.
   * Requirements: 4.4
   */
  async generateEmbeddings(text: string): Promise<number[]> {
    this.ensureInitialized();

    return retryWithBackoff(async () => {
      try {
        const response = await fetch('https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-mpnet-base-v2', {
          headers: {
            Authorization: `Bearer ${process.env.HF_TOKEN}`,
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({ inputs: [text] }),
        });

        if (!response.ok) {
          const errorData = await response.text();
          throw new Error(`HF API error: ${response.status} - ${errorData}`);
        }

        const result = await response.json() as any[];
        return result[0];
      } catch (error: any) {
        const statusCode = error.status || error.code || 500;
        throw new GenkitAPIError(
          `Embedding generation failed: ${error.message}`,
          statusCode,
          GenkitAPIError.isRecoverableStatusCode(statusCode),
          { endpoint: 'embed', textLength: text.length, timestamp: new Date() }
        );
      }
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      logger: this.logger,
      component: 'GenkitEngine',
      operationName: 'generateEmbeddings'
    });
  }

  /**
   * Generates embeddings for a search query.
   * Requirements: 7.1
   */
  async generateQueryEmbeddings(query: string): Promise<number[]> {
    return this.generateEmbeddings(query);
  }

  private ensureInitialized(): void {
    if (!this.ai) {
      throw new Error('GenkitEngine has not been initialized. Call initialize() first.');
    }
  }
}
