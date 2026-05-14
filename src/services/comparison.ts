/**
 * Comparison Service
 * 
 * Extracts ontology from a normative document and compares it
 * against a program/syllabus document to detect coverage gaps.
 */

import { genkit, Genkit } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { groq } from 'genkitx-groq';
import { z } from 'zod';
import { createLogger } from './logger';
import { retryWithBackoff } from '../utils/retry';

const logger = createLogger();

// ── Types ──

export interface OntologyItem {
  id: string;
  category: string;
  requirement: string;
  description: string;
  keywords: string[];
}

export interface ComparisonResult {
  item: OntologyItem;
  status: 'covered' | 'partial' | 'missing';
  confidence: number;
  evidence: string;
  suggestion: string;
}

export interface ComparisonReport {
  normativeDocument: string;
  programDocument: string;
  ontology: OntologyItem[];
  results: ComparisonResult[];
  summary: {
    total: number;
    covered: number;
    partial: number;
    missing: number;
    coveragePercent: number;
  };
  timestamp: string;
}

// ── Zod Schemas for Genkit structured output ──

const OntologyItemSchema = z.object({
  id: z.string(),
  category: z.string(),
  requirement: z.string(),
  description: z.string(),
  keywords: z.array(z.string())
});

const OntologyOutputSchema = z.object({
  items: z.array(OntologyItemSchema)
});

const ComparisonItemSchema = z.object({
  itemId: z.string(),
  status: z.enum(['covered', 'partial', 'missing']),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
  suggestion: z.string()
});

const ComparisonOutputSchema = z.object({
  results: z.array(ComparisonItemSchema)
});

// ── Service ──

export class ComparisonService {
  private ai: Genkit;

  constructor(apiKey: string) {
    this.ai = genkit({
      plugins: [
        googleAI({ apiKey }),
        groq({ apiKey: process.env.GROQ_API_KEY })
      ],
    });
  }

  private async generateWithRetry(options: any, operationName: string): Promise<any> {
    return retryWithBackoff(async () => {
      return await this.ai.generate(options);
    }, {
      maxRetries: 5,
      initialDelayMs: 15000,
      maxDelayMs: 60000,
      component: 'ComparisonService',
      operationName,
      logger
    });
  }

  /**
   * Extracts ontology items from a normative document.
   */
  async extractOntology(normativeText: string): Promise<OntologyItem[]> {
    logger.info('Comparison', 'Extracting ontology from normative document...');

    // Limit text to avoid Groq 30k TPM limits (approx 70,000 chars ~ 15k-18k tokens)
    const MAX_CHARS = 70000;
    const safeText = normativeText.length > MAX_CHARS 
      ? normativeText.substring(0, MAX_CHARS) + '\n\n[DOCUMENTO TRUNCADO POR LÍMITES DE API]' 
      : normativeText;

    const prompt = `Eres un experto en análisis de documentos normativos educativos.

Analiza el siguiente documento normativo y extrae una ontología estructurada de TODOS los requisitos, competencias, contenidos mínimos, criterios y estándares que establece.

Para cada elemento de la ontología, proporciona:
- id: Un identificador único corto (ej: "REQ-001", "COMP-003")
- category: La categoría del requisito (ej: "Contenido Mínimo", "Competencia", "Carga Horaria", "Perfil del Egresado", "Metodología", "Evaluación", "Bibliografía", "Correlatividades", "Objetivos")
- requirement: El requisito en forma concisa
- description: Descripción detallada del requisito
- keywords: Palabras clave asociadas para facilitar la comparación

Sé exhaustivo. Extrae TODOS los puntos relevantes del documento normativo.

DOCUMENTO NORMATIVO:
${safeText}`;

    const response = await this.generateWithRetry({
      model: 'groq/meta-llama/llama-4-scout-17b-16e-instruct',
      prompt,
      output: { format: 'json', schema: OntologyOutputSchema },
      config: { maxOutputTokens: 2048 }
    }, 'extractOntology');

    const data = response.output;
    if (!data || !data.items) {
      throw new Error('No se pudo extraer la ontología del documento normativo');
    }

    logger.info('Comparison', `Ontología extraída: ${data.items.length} elementos`);
    return data.items;
  }

  /**
   * Compares a program document against an extracted ontology.
   */
  async compareWithProgram(
    ontology: OntologyItem[],
    programText: string
  ): Promise<ComparisonResult[]> {
    logger.info('Comparison', `Comparando programa exhaustivamente contra ${ontology.length} elementos de la ontología...`);

    // Process in batches to avoid token limits
    const batchSize = 15;
    const allResults: ComparisonResult[] = [];

    // Chunk the program text into parts of ~40,000 characters (~10k tokens)
    const MAX_CHUNK_CHARS = 40000;
    const programChunks: string[] = [];
    for (let i = 0; i < programText.length; i += MAX_CHUNK_CHARS) {
      programChunks.push(programText.substring(i, i + MAX_CHUNK_CHARS));
    }
    
    logger.info('Comparison', `El programa se ha dividido en ${programChunks.length} partes para un análisis profundo.`);

    for (let i = 0; i < ontology.length; i += batchSize) {
      const batch = ontology.slice(i, i + batchSize);
      
      const bestResults = new Map<string, ComparisonResult>();

      for (let j = 0; j < programChunks.length; j++) {
        const chunk = programChunks[j];
        logger.info('Comparison', `Evaluando lote de items ${Math.floor(i/batchSize) + 1} contra parte ${j + 1}/${programChunks.length} del programa...`);
        
        const chunkResults = await this.compareBatch(batch, chunk);
        
        // Merge results: keep the best status (covered > partial > missing)
        for (const res of chunkResults) {
          const existing = bestResults.get(res.item.id);
          if (!existing) {
            bestResults.set(res.item.id, res);
          } else {
            const statusValue = { 'covered': 3, 'partial': 2, 'missing': 1 };
            if (statusValue[res.status] > statusValue[existing.status]) {
              bestResults.set(res.item.id, res);
            } else if (statusValue[res.status] === statusValue[existing.status] && existing.status !== 'missing') {
              existing.evidence += `\n[Parte ${j+1}]: ` + res.evidence;
            }
          }
        }

        // Wait between chunks to respect the 30k TPM rate limit of Groq's free tier
        if (j < programChunks.length - 1) {
          logger.info('Comparison', 'Esperando 25 segundos para respetar el límite de tokens por minuto (TPM) de Groq...');
          await new Promise(resolve => setTimeout(resolve, 25000));
        }
      }

      allResults.push(...Array.from(bestResults.values()));

      // Add a delay between batches of items
      if (i + batchSize < ontology.length) {
        logger.info('Comparison', 'Esperando 25 segundos antes de evaluar el siguiente lote de requisitos...');
        await new Promise(resolve => setTimeout(resolve, 25000));
      }
    }

    return allResults;
  }

  private async compareBatch(
    items: OntologyItem[],
    programText: string
  ): Promise<ComparisonResult[]> {
    const itemsList = items.map(item =>
      `- ID: ${item.id} | Categoría: ${item.category} | Requisito: ${item.requirement} | Descripción: ${item.description} | Keywords: ${item.keywords.join(', ')}`
    ).join('\n');

    const prompt = `Eres un experto en evaluación de programas educativos.

Compara el siguiente PROGRAMA DE MATERIA con los requisitos de la ontología normativa listados abajo.

Para CADA requisito, determina:
- itemId: El ID del requisito
- status: "covered" si el programa lo cubre adecuadamente, "partial" si lo cubre parcialmente, "missing" si no lo cubre
- confidence: Tu nivel de confianza en la evaluación (0 a 1)
- evidence: Cita o referencia del texto del programa que respalda tu evaluación (si es "missing", indica qué falta)
- suggestion: Sugerencia concreta para mejorar la cobertura (si es "covered", puedes dejar vacío o confirmar)

REQUISITOS DE LA ONTOLOGÍA NORMATIVA:
${itemsList}

PROGRAMA DE LA MATERIA:
${programText}`;

    const response = await this.generateWithRetry({
      model: 'groq/meta-llama/llama-4-scout-17b-16e-instruct',
      prompt,
      output: { format: 'json', schema: ComparisonOutputSchema },
      config: { maxOutputTokens: 2048 }
    }, 'compareBatch');

    const data = response.output;
    if (!data || !data.results) return [];

    // Merge results with ontology items
    return data.results.map((r: any) => {
      const item = items.find(i => i.id === r.itemId) || items[0];
      return {
        item,
        status: r.status,
        confidence: r.confidence,
        evidence: r.evidence,
        suggestion: r.suggestion
      };
    });
  }

  /**
   * Full comparison pipeline: extract ontology + compare.
   */
  async fullComparison(
    normativeText: string,
    programText: string,
    normativeName: string,
    programName: string
  ): Promise<ComparisonReport> {
    const ontology = await this.extractOntology(normativeText);
    const results = await this.compareWithProgram(ontology, programText);

    const covered = results.filter(r => r.status === 'covered').length;
    const partial = results.filter(r => r.status === 'partial').length;
    const missing = results.filter(r => r.status === 'missing').length;
    const total = results.length;

    return {
      normativeDocument: normativeName,
      programDocument: programName,
      ontology,
      results,
      summary: {
        total,
        covered,
        partial,
        missing,
        coveragePercent: total > 0 ? Math.round((covered + partial * 0.5) / total * 100) : 0
      },
      timestamp: new Date().toISOString()
    };
  }
}
