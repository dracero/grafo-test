/**
 * Genkit Engine Implementation
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 7.1
 */

import { genkit, Genkit } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { groq } from 'genkitx-groq';
import { z } from 'zod';
import {
  GenkitEngine,
  AnalysisResult,
  GoogleConfig,
  EntityType
} from '../models/genkit.types';
import { GenkitAPIError } from '../errors/genkit.errors';
import { retryWithBackoff } from '../utils/retry';
import { createLogger } from './logger';

export class GenkitEngineImpl implements GenkitEngine {
  private ai?: Genkit;
  private logger = createLogger();

  /**
   * Initializes Genkit with Google AI plugin
   * Requirements: 4.1
   */
  async initialize(config: GoogleConfig): Promise<void> {
    try {
      this.ai = genkit({
        plugins: [
          googleAI({ apiKey: config.apiKey }),
          groq({ apiKey: process.env.GROQ_API_KEY })
        ],
      });
      this.logger.info('GenkitEngine', 'Genkit initialized successfully');
    } catch (error: any) {
      this.logger.error('GenkitEngine', 'Failed to initialize Genkit', error);
      throw new Error(`Genkit initialization failed: ${error.message}`);
    }
  }

  /**
   * Analyzes text to extract entities and relationships
   * Requirements: 4.2, 4.3, 4.5
   */
  async analyzeText(text: string): Promise<AnalysisResult> {
    this.ensureInitialized();

    return retryWithBackoff(async () => {
      try {
        this.logger.debug('GenkitEngine', `Analyzing text of length ${text.length}`);

        // Define the output schema using Zod
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

        // Generate embeddings for the source text
        const embeddings = await this.generateEmbeddings(text);

        return {
          entities: data.entities,
          relationships: data.relationships,
          embeddings,
          sourceText: text
        };
      } catch (error: any) {
        // Map to GenkitAPIError
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
   * Generates vector embeddings for a text using HuggingFace
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
        // Return the first embedding vector
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
   * Generates embeddings for a search query
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
