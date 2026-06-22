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
import { apiKeyManager } from '../utils/api-key-manager';
import { googleRateLimiter } from '../utils/rate-limiter';
import { tracer, SpanKind, SpanStatusCode } from '../utils/tracing';

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
  private aiInstances = new Map<string, Genkit>();
  private defaultApiKey: string = '';
  private logger = createLogger();

  /**
   * Initializes Genkit with Google AI, Groq, and Neo4j Agent Skills plugins.
   * Requirements: 4.1
   */
  async initialize(config: GoogleConfig): Promise<void> {
    try {
      this.defaultApiKey = config.apiKey || '';
      // Warm up the default instance
      this.getAiInstance(this.defaultApiKey);
      this.logger.info('GenkitEngine', 'Genkit initialized with Neo4j Agent Skills plugin');
    } catch (error: any) {
      this.logger.error('GenkitEngine', 'Failed to initialize Genkit', error);
      throw new Error(`Genkit initialization failed: ${error.message}`);
    }
  }

  /**
   * Internal helper to cache and return a Genkit instance configured with a specific key.
   */
  private getAiInstance(apiKey: string): Genkit {
    let instance = this.aiInstances.get(apiKey);
    if (!instance) {
      instance = genkit({
        plugins: [
          googleAI({ apiKey }),
          // ── Neo4j Agent Skills plugin ─────────────────────────────────────
          neo4j([
            {
              indexId: ENTITY_INDEX_ID,
              embedder: undefined as any,
            },
          ]),
        ],
      });
      this.aiInstances.set(apiKey, instance);
    }
    return instance;
  }

  /**
   * Dynamically resolves the Genkit instance using the currently active key from ApiKeyManager.
   */
  getOrCreateAi(): Genkit {
    const key = apiKeyManager.getCurrentKey() || this.defaultApiKey;
    return this.getAiInstance(key);
  }

  /**
   * Returns the internal Genkit `ai` instance so that other services
   * (e.g. KnowledgeGraphBuilderImpl) can call ai.index() / ai.retrieve().
   */
  getAi(): Genkit {
    this.ensureInitialized();
    return this.getOrCreateAi();
  }

  /**
   * Analyzes text to extract entities and relationships.
   * Requirements: 4.2, 4.3, 4.5
   */
  async analyzeText(text: string): Promise<AnalysisResult> {
    this.ensureInitialized();

    return retryWithBackoff(async () => {
      const currentKey = apiKeyManager.getCurrentKey();
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

      const span = tracer.startSpan('GenkitEngine:analyzeText', {
        kind: SpanKind.CLIENT,
        attributes: {
          'langsmith.span.kind': 'LLM',
          'gen_ai.system': 'gemini',
          'gen_ai.request.model': 'googleai/gemini-2.5-flash',
          'inputs': JSON.stringify({ prompt })
        }
      });

      try {
        this.logger.debug('GenkitEngine', `Analyzing text of length ${text.length}`);

        await googleRateLimiter.throttle();
        const ai = this.getOrCreateAi();
        const response = await ai.generate({
          model: 'googleai/gemini-2.5-flash',
          prompt: prompt,
          output: {
            format: 'json',
            schema: OutputSchema
          },
          config: { maxOutputTokens: 2048 }
        });

        const genkitUsage = response.usage;
        if (genkitUsage) {
          this.logger.info('GenkitEngine', `[analyzeText] Token usage - Input: ${genkitUsage.inputTokens}, Output: ${genkitUsage.outputTokens}, Total: ${genkitUsage.totalTokens}`);
          span.setAttributes({
            'gen_ai.usage.prompt_tokens': genkitUsage.inputTokens,
            'gen_ai.usage.completion_tokens': genkitUsage.outputTokens,
            'gen_ai.usage.total_tokens': genkitUsage.totalTokens
          });
        }

        const data = response.output;
        if (!data) {
          throw new Error('No data returned from model');
        }

        span.setAttribute('outputs', JSON.stringify(data));
        span.setStatus({ code: SpanStatusCode.OK });

        const embeddings = await this.generateEmbeddings(text);

        return {
          entities: data.entities,
          relationships: data.relationships,
          embeddings,
          sourceText: text
        };
      } catch (error: any) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
        
        const statusCode = error.status || error.code || 500;
        const errMsg = String(error.message || '').toLowerCase();
        const isRateOrUnavailable = statusCode === 429 || statusCode === 503 ||
                                    errMsg.includes('503') || errMsg.includes('429') ||
                                    errMsg.includes('unavailable') || errMsg.includes('resource exhausted') ||
                                    errMsg.includes('rate limit') || errMsg.includes('api_key_invalid') ||
                                    errMsg.includes('invalid api key');

        if (isRateOrUnavailable) {
          apiKeyManager.rotateKey(currentKey);
        }
        throw new GenkitAPIError(
          `Analysis failed: ${error.message}`,
          statusCode,
          GenkitAPIError.isRecoverableStatusCode(statusCode),
          { endpoint: 'generate', textLength: text.length, timestamp: new Date() }
        );
      } finally {
        span.end();
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
        const ai = this.getOrCreateAi();
        await ai.index({
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
        const ai = this.getOrCreateAi();
        const docs = await ai.retrieve({
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
    if (this.aiInstances.size === 0) {
      throw new Error('GenkitEngine has not been initialized. Call initialize() first.');
    }
  }
}
