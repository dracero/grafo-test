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
      `Comparando holísticamente: ${normativeOntology.length} normativos vs ${programOntology.length} del programa…`
    );

    const normativeList = normativeOntology
      .map(
        (item) =>
          `ID: ${item.id} | Categoría: ${item.category} | Requisito: ${item.requirement} | Descripción: ${item.description} | Keywords: ${(item.keywords || []).join(', ')}`
      )
      .join('\n');

    const programList = programOntology
      .map(
        (item) =>
          `- [${item.category}] ${item.requirement}: ${item.description} (Keywords: ${(item.keywords || []).join(', ')})`
      )
      .join('\n');

    const prompt = `Eres un experto en evaluación de programas educativos universitarios y análisis de similitud semántica.

Evalúa el CUMPLIMIENTO NORMATIVO de un programa frente a ${normativeOntology.length} requisitos normativos.

IMPORTANTE - AGRUPACIÓN DE NIVELES:
- Si varios requisitos consecutivos pertenecen a la MISMA competencia pero diferentes niveles (ej: REQ-028 a REQ-032 todos sobre "Bienestar digital"), AGRÚPALOS en UNA SOLA evaluación.
- Usa el ID del primer requisito del grupo (ej: REQ-028).
- En la evidencia y sugerencia, menciona que aplica a TODOS los niveles de esa competencia.
- Esto evita repeticiones innecesarias.

Para CADA requisito o GRUPO de requisitos de la misma competencia, determina:
- itemId: ID del requisito normativo (o del primero del grupo)
- status: "covered" (cubierto completamente) | "partial" (cubierto parcialmente) | "missing" (ausente)
- confidence: número entre 0.0 y 1.0
- evidence: qué elementos del programa lo cubren o qué falta (menciona si aplica a múltiples niveles)
- suggestion: sugerencia concreta para mejorar (o "Ninguna" si está cubierto)

Usa razonamiento semántico: un requisito puede estar cubierto aunque se exprese con palabras diferentes.

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
REQUISITOS NORMATIVOS (${normativeOntology.length} items):
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
      'compareOntologies'
    );

    const rawText = response.text ?? '';
    const rawResults = parseComparisonResponse(rawText);

    logger.info('Comparison', `✅ Comparación completada: ${rawResults.length} evaluaciones recibidas de ${normativeOntology.length} esperadas`);

    // Expandir resultados agrupados a todos los requisitos individuales
    const expandedResults: ComparisonResult[] = [];
    const processedIds = new Set<string>();

    for (const r of rawResults) {
      if (!r.itemId || !r.status) continue;

      const baseItem = normativeOntology.find((i) => i.id === r.itemId);
      if (!baseItem) continue;

      // Detectar si este resultado aplica a múltiples niveles de la misma competencia
      // Patrón: REQ-028, REQ-029, REQ-030, etc. con la misma competencia base
      const baseIdMatch = baseItem.id.match(/^(REQ-\d+)/);
      if (baseIdMatch) {
        const baseIdNum = parseInt(baseIdMatch[1].replace('REQ-', ''), 10);
        
        // Buscar requisitos consecutivos con la misma competencia base
        const relatedItems = normativeOntology.filter(item => {
          const itemIdNum = parseInt(item.id.replace('REQ-', ''), 10);
          // Considerar relacionados si están en un rango de 5 IDs (típicamente 5 niveles)
          return itemIdNum >= baseIdNum && 
                 itemIdNum < baseIdNum + 5 &&
                 item.category === baseItem.category &&
                 item.requirement.split(':')[0] === baseItem.requirement.split(':')[0];
        });

        // Si encontramos múltiples niveles, aplicar el mismo resultado a todos
        if (relatedItems.length > 1) {
          for (const item of relatedItems) {
            if (!processedIds.has(item.id)) {
              expandedResults.push({
                item,
                status: r.status as 'covered' | 'partial' | 'missing',
                confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
                evidence: String(r.evidence ?? ''),
                suggestion: String(r.suggestion ?? ''),
              });
              processedIds.add(item.id);
            }
          }
          continue;
        }
      }

      // Si no es un grupo, agregar el resultado individual
      if (!processedIds.has(baseItem.id)) {
        expandedResults.push({
          item: baseItem,
          status: r.status as 'covered' | 'partial' | 'missing',
          confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
          evidence: String(r.evidence ?? ''),
          suggestion: String(r.suggestion ?? ''),
        });
        processedIds.add(baseItem.id);
      }
    }

    // Agregar requisitos no procesados como "missing" con baja confianza
    for (const item of normativeOntology) {
      if (!processedIds.has(item.id)) {
        expandedResults.push({
          item,
          status: 'missing',
          confidence: 0.3,
          evidence: 'No se encontró evaluación para este requisito en la comparación.',
          suggestion: 'Revisar manualmente si este requisito está cubierto en el programa.',
        });
      }
    }

    logger.info('Comparison', `📋 Resultados expandidos: ${expandedResults.length} evaluaciones finales`);

    return expandedResults;
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
      results,
      summary: { total, covered, partial, missing, coveragePercent },
      timestamp: new Date().toISOString(),
    };
  }
}
