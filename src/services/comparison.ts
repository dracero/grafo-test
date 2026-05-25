/**
 * Comparison Service
 *
 * Extracts ontology from a normative document and compares it
 * against a program/syllabus document to detect coverage gaps.
 *
 * Strategy:
 *   - Uses Gemini 2.5 Flash (1M-token context, compatible with free API keys).
 *   - Sends the ENTIRE document text — no chunking, no truncation unless
 *     the combined text genuinely exceeds the safe limit (~700k chars/doc).
 *   - Performs a SINGLE holistic comparison call instead of batches.
 *   - Uses format:'text' + manual JSON parsing so a truncated response
 *     never crashes the pipeline — all complete items are recovered.
 *   - maxOutputTokens set to 65 536 (Flash maximum).
 */

import { genkit, Genkit } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { Agent, setGlobalDispatcher } from 'undici';
import { createLogger } from './logger';
import { retryWithBackoff } from '../utils/retry';

// Configure global dispatcher to prevent HeadersTimeoutError during long comparisons
setGlobalDispatcher(new Agent({
  headersTimeout: 600_000, // 10 minutes
  bodyTimeout: 600_000,    // 10 minutes
  keepAliveTimeout: 60_000,
  connections: 20,
}));

const logger = createLogger();

// ─── Model constants ───────────────────────────────────────────────────────
const MODEL_FLASH = 'googleai/gemini-2.5-flash';

// 65 536 is the maximum output token limit for Gemini 2.5 Flash.
const MAX_OUTPUT_TOKENS = 65_536;

// Safe upper limit per document: ~700k chars ≈ 175k tokens.
const MAX_CHARS_PER_DOC = 700_000;

// ── Types ──────────────────────────────────────────────────────────────────

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
  programOntology?: OntologyItem[];
  results: ComparisonResult[];
  summary: {
    total: number;
    covered: number;
    partial: number;
    missing: number;
    coveragePercent: number;
  };
  timestamp: string;
  normativeText?: string;
  programText?: string;
}

// ── JSON recovery helpers ──────────────────────────────────────────────────

/**
 * Extracts all complete JSON objects from a (possibly truncated) JSON array string.
 * Parses object by object using brace counting so a cut-off response never
 * causes a total failure — everything generated before the truncation is kept.
 */
function extractCompleteObjects(text: string): any[] {
  const objects: any[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(text.substring(start, i + 1));
          objects.push(obj);
        } catch {
          // skip malformed object
        }
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parses an ontology items response from raw text.
 * Tries full JSON.parse first; falls back to object-by-object extraction.
 */
function parseOntologyResponse(raw: string): OntologyItem[] {
  // Strip markdown fences if present
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();

  // 1. Try standard full parse
  try {
    const parsed = JSON.parse(cleaned);
    const items = parsed?.items ?? parsed;
    if (Array.isArray(items)) {
      return items.filter(isValidOntologyItem).map(normalizeOntologyItem);
    }
  } catch { /* fall through */ }

  // 2. Try extracting the "items" array substring
  const arrMatch = cleaned.match(/"items"\s*:\s*\[/);
  const arrStart = arrMatch ? cleaned.indexOf('[', (arrMatch.index ?? 0)) : cleaned.indexOf('[');
  const searchText = arrStart >= 0 ? cleaned.substring(arrStart) : cleaned;

  const objects = extractCompleteObjects(searchText);
  return objects.filter(isValidOntologyItem).map(normalizeOntologyItem);
}

function isValidOntologyItem(obj: any): boolean {
  return obj && typeof obj.id === 'string' && typeof obj.requirement === 'string';
}

function normalizeOntologyItem(obj: any): OntologyItem {
  return {
    id:          String(obj.id ?? ''),
    category:    String(obj.category ?? 'General'),
    requirement: String(obj.requirement ?? ''),
    description: String(obj.description ?? obj.requirement ?? ''),
    keywords:    Array.isArray(obj.keywords) ? obj.keywords.map(String) : [],
  };
}

/**
 * Parses a comparison results response from raw text.
 */
function parseComparisonResponse(raw: string): any[] {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    const results = parsed?.results ?? parsed;
    if (Array.isArray(results)) return results;
  } catch { /* fall through */ }

  // Fallback: extract complete objects from array
  const arrIdx = cleaned.indexOf('[');
  const searchText = arrIdx >= 0 ? cleaned.substring(arrIdx) : cleaned;
  return extractCompleteObjects(searchText);
}

// ── Service ────────────────────────────────────────────────────────────────

export class ComparisonService {
  private ai: Genkit;

  constructor(apiKey: string) {
    this.ai = genkit({
      plugins: [
        googleAI({ apiKey }),
      ],
    });
  }

  private async generateWithRetry(options: any, operationName: string): Promise<any> {
    return retryWithBackoff(
      async () => this.ai.generate(options),
      {
        maxRetries: 5,
        initialDelayMs: 15_000,
        maxDelayMs: 90_000,
        component: 'ComparisonService',
        operationName,
        logger,
      }
    );
  }

  private safeText(text: string, label: string): string {
    if (text.length <= MAX_CHARS_PER_DOC) return text;
    logger.warn(
      'Comparison',
      `[${label}] Documento muy largo (${text.length} chars) — truncado a ${MAX_CHARS_PER_DOC} chars.`
    );
    return text.substring(0, MAX_CHARS_PER_DOC) + '\n\n[DOCUMENTO TRUNCADO — supera el límite de la API]';
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async extractOntology(normativeText: string): Promise<OntologyItem[]> {
    logger.info('Comparison', 'Extrayendo ontología del documento normativo con Gemini 2.5 Flash…');
    const safeText = this.safeText(normativeText, 'Normativo');

    const prompt = `Eres un experto en análisis de documentos normativos educativos y acreditación universitaria.

Analiza el siguiente documento normativo en su TOTALIDAD y extrae una ontología EXHAUSTIVA de TODOS los requisitos, competencias, contenidos mínimos, criterios y estándares que establece.

INSTRUCCIONES:
1. Lee y analiza el documento COMPLETO.
2. Captura CADA requisito detectable.
3. Categorías posibles: "Contenido Mínimo", "Competencia", "Carga Horaria", "Perfil del Egresado", "Metodología", "Evaluación", "Bibliografía", "Correlatividades", "Objetivos", "Infraestructura", "Docentes", "Investigación".
4. Devuelve un JSON con la siguiente estructura exacta. No incluyas markdown, solo el JSON puro:

{"items": [
  {
    "id": "REQ-001",
    "category": "Contenido Mínimo",
    "requirement": "Requisito conciso",
    "description": "Descripción detallada",
    "keywords": ["palabra1", "palabra2"]
  }
]}

DOCUMENTO NORMATIVO:
${safeText}`;

    const response = await this.generateWithRetry(
      {
        model: MODEL_FLASH,
        prompt,
        output: { format: 'text' },
        config: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      },
      'extractOntology'
    );

    const rawText = response.text ?? '';
    const items = parseOntologyResponse(rawText);

    if (items.length === 0) {
      throw new Error('No se pudo extraer ningún ítem de la ontología normativa');
    }

    logger.info('Comparison', `✅ Ontología normativa extraída: ${items.length} elementos`);
    return items;
  }

  async extractProgramOntology(programText: string): Promise<OntologyItem[]> {
    logger.info('Comparison', 'Extrayendo ontología del programa con Gemini 2.5 Flash…');
    const safeText = this.safeText(programText, 'Programa');

    const prompt = `Eres un experto en análisis de programas educativos universitarios (sílabos).

Analiza el siguiente programa de materia en su TOTALIDAD y extrae una ontología EXHAUSTIVA de TODOS sus contenidos, objetivos, metodologías, evaluaciones, bibliografía y demás elementos educativos.

INSTRUCCIONES:
1. Lee y analiza el documento COMPLETO.
2. Captura CADA contenido, tema, objetivo o requisito detectable.
3. Categorías posibles: "Contenido", "Objetivo General", "Objetivo Específico", "Metodología", "Evaluación", "Bibliografía Obligatoria", "Bibliografía Complementaria", "Carga Horaria", "Correlativas", "Perfil del Graduado", "Actividades Profesionales Reservadas", "Alcances del Título", "Estructura Curricular", "Proyectos Integradores".
4. Devuelve un JSON con la siguiente estructura exacta. No incluyas markdown, solo el JSON puro:

{"items": [
  {
    "id": "PROG-CONT-001",
    "category": "Contenido",
    "requirement": "Tema o punto conciso",
    "description": "Descripción detallada",
    "keywords": ["palabra1", "palabra2"]
  }
]}

PROGRAMA DE LA MATERIA:
${safeText}`;

    const response = await this.generateWithRetry(
      {
        model: MODEL_FLASH,
        prompt,
        output: { format: 'text' },
        config: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      },
      'extractProgramOntology'
    );

    const rawText = response.text ?? '';
    const items = parseOntologyResponse(rawText);

    if (items.length === 0) {
      throw new Error('No se pudo extraer ningún ítem de la ontología del programa');
    }

    logger.info('Comparison', `✅ Ontología del programa extraída: ${items.length} elementos`);
    return items;
  }

  async compareOntologies(
    normativeOntology: OntologyItem[],
    programOntology: OntologyItem[]
  ): Promise<ComparisonResult[]> {
    logger.info(
      'Comparison',
      `Comparando holísticamente en lotes: ${normativeOntology.length} normativos vs ${programOntology.length} del programa…`
    );

    const BATCH_SIZE = 100;
    const allResults: ComparisonResult[] = [];

    const programList = programOntology
      .map(
        (item) =>
          `- [${item.category}] ${item.requirement}: ${item.description} (Keywords: ${(item.keywords || []).join(', ')})`
      )
      .join('\n');

    for (let i = 0; i < normativeOntology.length; i += BATCH_SIZE) {
      if (i > 0) {
        logger.info('Comparison', 'Waiting 6 seconds to respect Gemini API rate limits (15/20 RPM)...');
        await new Promise((resolve) => setTimeout(resolve, 6000));
      }

      const batch = normativeOntology.slice(i, i + BATCH_SIZE);
      logger.info(
        'Comparison',
        `Procesando lote ${Math.floor(i / BATCH_SIZE) + 1} de ${Math.ceil(
          normativeOntology.length / BATCH_SIZE
        )} (${batch.length} requisitos)…`
      );

      const normativeList = batch
        .map(
          (item) =>
            `ID: ${item.id} | Categoría: ${item.category} | Requisito: ${item.requirement} | Descripción: ${item.description} | Keywords: ${(item.keywords || []).join(', ')}`
        )
        .join('\n');

      const prompt = `Eres un experto en evaluación de programas de materias universitarias y análisis de conformidad regulatoria.
Analiza la cobertura del programa de materia frente a los siguientes ${batch.length} requisitos normativos.

Para CADA requisito normativo (hay exactamente ${batch.length}), determina:
- itemId: ID del requisito normativo
- status: "covered" (cubierto completamente en el programa) | "partial" (cubierto parcialmente) | "missing" (ausente/no cubierto en el programa)
- confidence: número entre 0.0 y 1.0 que indica tu certeza
- evidence: 
  * Si está "covered" o "partial": cita textualmente o resume los temas, contenidos, objetivos o prácticas específicas del programa que demuestran su cobertura.
  * Si está "missing": explica detalladamente por qué no se encuentra en el programa (por ejemplo, si el requisito es una competencia docente general o de nivel institucional y por ende no aplica a una materia específica de física, indícalo claramente en lugar de dar una respuesta genérica).
- suggestion: recomendación pedagógica específica y aplicable para incorporar este aspecto al programa, o "Ninguna" si ya está completamente cubierto o si no aplica a la materia.

Usa razonamiento semántico avanzado: un requisito puede estar cubierto conceptualmente aunque se exprese con terminología diferente. Evita dar respuestas genéricas como "revisar manualmente".

Devuelve un JSON con la siguiente estructura exacta. No incluyas markdown, solo el JSON puro:

{"results": [
  {
    "itemId": "REQ-001",
    "status": "covered",
    "confidence": 0.9,
    "evidence": "...",
    "suggestion": "Ninguna"
  }
]}

═══════════════════════════════════════════════════════════
REQUISITOS NORMATIVOS DE ESTE LOTE (${batch.length} items):
═══════════════════════════════════════════════════════════
${normativeList}

═══════════════════════════════════════════════════════════
PROGRAMA DE LA MATERIA (${programOntology.length} items):
═══════════════════════════════════════════════════════════
${programList}`;

      const response = await this.generateWithRetry(
        {
          model: MODEL_FLASH,
          prompt,
          output: { format: 'text' },
          config: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        },
        `compareOntologies_batch_${Math.floor(i / BATCH_SIZE) + 1}`
      );

      const rawText = response.text ?? '';
      const rawResults = parseComparisonResponse(rawText);

      const batchResults = rawResults
        .filter((r: any) => r.itemId && r.status)
        .map((r: any) => {
          const item = batch.find((i) => i.id === r.itemId) || batch[0];
          return {
            item,
            status: r.status as 'covered' | 'partial' | 'missing',
            confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
            evidence: String(r.evidence ?? ''),
            suggestion: String(r.suggestion ?? ''),
          };
        });

      // Asegurar que todos los elementos del lote tengan un resultado
      for (const item of batch) {
        const found = batchResults.find((br) => br.item.id === item.id);
        if (found) {
          allResults.push(found);
        } else {
          allResults.push({
            item,
            status: 'missing',
            confidence: 0.0,
            evidence: 'No se obtuvo respuesta del modelo de lenguaje para este requisito durante el procesamiento.',
            suggestion: 'Reintentar la comparación o verificar el documento de forma manual.'
          });
        }
      }
    }

    return allResults;
  }

  async fullComparison(
    normativeText: string,
    programText: string,
    normativeName: string,
    programName: string
  ): Promise<ComparisonReport> {
    logger.info('Comparison', `Iniciando comparación: "${normativeName}" vs "${programName}"`);
    logger.info('Comparison', `Normativo: ${normativeText.length} chars | Programa: ${programText.length} chars`);

    const ontology        = await this.extractOntology(normativeText);
    const programOntology = await this.extractProgramOntology(programText);
    const results         = await this.compareOntologies(ontology, programOntology);

    const covered = results.filter((r) => r.status === 'covered').length;
    const partial = results.filter((r) => r.status === 'partial').length;
    const missing = results.filter((r) => r.status === 'missing').length;
    const total   = results.length;

    const coveragePercent = total > 0
      ? Math.round(((covered + partial * 0.5) / total) * 100)
      : 0;

    logger.info(
      'Comparison',
      `📊 Resumen: ${covered} cubiertos | ${partial} parciales | ${missing} faltantes | Cumplimiento: ${coveragePercent}%`
    );

    return {
      normativeDocument: normativeName,
      programDocument: programName,
      ontology,
      programOntology,
      results,
      summary: { total, covered, partial, missing, coveragePercent },
      timestamp: new Date().toISOString(),
      normativeText,
      programText,
    };
  }
}
