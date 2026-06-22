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
import { apiKeyManager } from '../utils/api-key-manager';
import { googleRateLimiter } from '../utils/rate-limiter';
import { tracer, SpanKind, SpanStatusCode } from '../utils/tracing';

// Configure global dispatcher to prevent HeadersTimeoutError during long comparisons
setGlobalDispatcher(new Agent({
  headersTimeout: 600_000, // 10 minutes
  bodyTimeout: 600_000,    // 10 minutes
  keepAliveTimeout: 60_000,
  connections: 20,
}));

const logger = createLogger();

export function normalizeStatus(status: string): 'covered' | 'partial' | 'missing' {
  const s = String(status || '').trim().toLowerCase();
  if (s.includes('cubierto') || s.includes('covered') || s.includes('cumple') || s.includes('si') || s === 'ok') {
    return 'covered';
  }
  if (s.includes('parcial') || s.includes('partial')) {
    return 'partial';
  }
  if (s.includes('faltante') || s.includes('missing') || s.includes('no') || s.includes('ausente')) {
    return 'missing';
  }
  return 'missing'; // Safe default
}

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
  correctionsJson?: string | null;
  correctedText?: string | null;
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

function parseRetryDelay(error: any): number {
  const errMsg = String(error?.message || error?.originalMessage || error || '').toLowerCase();
  
  // 1. Try to find "Please retry in X.Ys"
  const match = errMsg.match(/retry in ([\d.]+)s/);
  if (match && match[1]) {
    const seconds = parseFloat(match[1]);
    if (!isNaN(seconds)) {
      return Math.ceil(seconds * 1000);
    }
  }

  // 2. Try to find "retryDelay": "Xs"
  const origMsg = String(error?.originalMessage || '');
  const match2 = origMsg.match(/"retryDelay":\s*"(\d+)s"/);
  if (match2 && match2[1]) {
    const seconds = parseInt(match2[1], 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }
  }

  return 0; // No delay found
}

// ── Service ────────────────────────────────────────────────────────────────

export class ComparisonService {
  private explicitApiKey?: string;
  private aiInstances = new Map<string, Genkit>();

  constructor(apiKey?: string) {
    this.explicitApiKey = apiKey;
  }

  private getAi(apiKey: string): Genkit {
    let ai = this.aiInstances.get(apiKey);
    if (!ai) {
      ai = genkit({
        plugins: [
          googleAI({ apiKey }),
        ],
      });
      this.aiInstances.set(apiKey, ai);
    }
    return ai;
  }

  private async generateWithRetry(options: any, operationName: string, provider?: string): Promise<any> {
    const isGroq = (provider || '').toLowerCase().trim() === 'groq';
    const modelName = isGroq ? 'llama-3.3-70b-versatile' : (options.model || 'googleai/gemini-2.5-flash');
    const systemName = isGroq ? 'groq' : 'gemini';

    let attempt = 0;
    const maxRetries = 8;
    let delay = isGroq ? 3000 : 5000;

    const span = tracer.startSpan(`ComparisonService:${operationName}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'langsmith.span.kind': 'LLM',
        'openinference.span.kind': 'LLM',
        'gen_ai.system': systemName,
        'gen_ai.request.model': modelName,
        'inputs': options.prompt,
        'input.value': options.prompt,
        'gen_ai.content.prompt': options.prompt
      }
    });

    try {
      while (attempt < maxRetries) {
        attempt++;
        try {
          if (isGroq) {
            const apiKey = apiKeyManager.getCurrentGroqKey();
            if (!apiKey) {
              throw new Error('GROQ_API_KEY is not defined in the environment or ApiKeyManager.');
            }
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                  { role: 'user', content: options.prompt }
                ],
                temperature: options.config?.temperature ?? 0.2,
                max_tokens: options.config?.maxOutputTokens ?? 4096,
              })
            });

            if (response.status === 413 || response.status === 429) {
              if (attempt >= maxRetries) {
                throw new Error(`Groq rate limit (${response.status}) hit after maximum attempts.`);
              }
              logger.warn('Comparison', `Groq rate/context limit hit (status ${response.status}). Rotating key...`);
              apiKeyManager.rotateGroqKey(apiKey);
              const sleepDelay = apiKeyManager.getGroqKeyCount() > 1 ? 1000 : delay;
              await new Promise(resolve => setTimeout(resolve, sleepDelay));
              if (apiKeyManager.getGroqKeyCount() <= 1) {
                delay *= 2;
              }
              continue;
            }

            if (!response.ok) {
              const errText = await response.text();
              throw new Error(`Groq API returned error status ${response.status}: ${errText}`);
            }
            const json = await response.json() as any;
            const content = json.choices?.[0]?.message?.content || '';
            const groqUsage = json.usage;
            if (groqUsage) {
              logger.info('Comparison', `[${operationName}] Groq token usage - Prompt: ${groqUsage.prompt_tokens}, Completion: ${groqUsage.completion_tokens}, Total: ${groqUsage.total_tokens}`);
              span.setAttributes({
                'gen_ai.usage.prompt_tokens': groqUsage.prompt_tokens,
                'gen_ai.usage.completion_tokens': groqUsage.completion_tokens,
                'gen_ai.usage.total_tokens': groqUsage.total_tokens
              });
            }
            span.setAttribute('outputs', content);
            span.setAttribute('output.value', content);
            span.setAttribute('gen_ai.content.completion', content);
            span.setStatus({ code: SpanStatusCode.OK });
            return { text: content };
          } else {
            const currentKey = this.explicitApiKey || apiKeyManager.getCurrentGoogleKey();
            try {
              await googleRateLimiter.throttle();
              const ai = this.getAi(currentKey);
              const response = await ai.generate(options);
              const genkitUsage = response.usage;
              if (genkitUsage) {
                logger.info('Comparison', `[${operationName}] Gemini token usage - Input: ${genkitUsage.inputTokens}, Output: ${genkitUsage.outputTokens}, Total: ${genkitUsage.totalTokens}`);
                span.setAttributes({
                  'gen_ai.usage.prompt_tokens': genkitUsage.inputTokens,
                  'gen_ai.usage.completion_tokens': genkitUsage.outputTokens,
                  'gen_ai.usage.total_tokens': genkitUsage.totalTokens
                });
              }
              span.setAttribute('outputs', response.text);
              span.setAttribute('output.value', response.text);
              span.setAttribute('gen_ai.content.completion', response.text);
              span.setStatus({ code: SpanStatusCode.OK });
              return response;
            } catch (error: any) {
              const status = error.status || error.code || 500;
              const errMsg = String(error.message || error.originalMessage || error || '').toLowerCase();
              const isRateOrUnavailable = status === 429 || status === 503 ||
                                          errMsg.includes('503') || errMsg.includes('429') ||
                                          errMsg.includes('unavailable') || errMsg.includes('resource exhausted') ||
                                          errMsg.includes('rate limit') || errMsg.includes('api_key_invalid') ||
                                          errMsg.includes('invalid api key');

              if (isRateOrUnavailable && attempt < maxRetries) {
                let sleepDelay = delay;
                let parsedDelay = 0;
                
                if (status === 503 || errMsg.includes('503') || errMsg.includes('overloaded') || errMsg.includes('service unavailable') || errMsg.includes('high demand')) {
                  // Service unavailable / high demand. Wait longer (at least 5s) as it's a global server overload.
                  sleepDelay = Math.max(sleepDelay, 5000);
                  logger.warn('Comparison', `[${operationName}] Gemini service overloaded (503). Waiting ${sleepDelay}ms...`);
                } else {
                  // Rate limit / Quota (429)
                  if (!this.explicitApiKey) {
                    apiKeyManager.rotateGoogleKey(currentKey);
                  }
                  parsedDelay = parseRetryDelay(error);
                  if (parsedDelay > 0) {
                    sleepDelay = Math.max(sleepDelay, parsedDelay + 1500);
                    logger.info('Comparison', `[${operationName}] Parsed rate limit retry delay of ${parsedDelay}ms from Gemini response.`);
                  } else {
                    sleepDelay = (!this.explicitApiKey && apiKeyManager.getGoogleKeyCount() > 1 && attempt < 3) ? 1500 : delay;
                  }
                }

                logger.warn('Comparison', `[${operationName}] Gemini error (status ${status}). Retrying in ${sleepDelay}ms... (Attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, sleepDelay));
                if (this.explicitApiKey || apiKeyManager.getGoogleKeyCount() <= 1 || status === 503 || parsedDelay > 0) {
                  delay *= 2;
                }
                continue;
              }
              throw error;
            }
          }
        } catch (err: any) {
          if (attempt >= maxRetries) {
            throw err;
          }
          
          let sleepDelay = delay;
          const parsedDelay = parseRetryDelay(err);
          if (parsedDelay > 0) {
            sleepDelay = Math.max(sleepDelay, parsedDelay + 1500);
            logger.info('Comparison', `[${operationName}] Parsed rate limit retry delay of ${parsedDelay}ms from connection error.`);
          } else {
            sleepDelay = ((isGroq ? apiKeyManager.getGroqKeyCount() : apiKeyManager.getGoogleKeyCount()) > 1 && attempt < 3) ? 1500 : delay;
          }

          logger.warn('Comparison', `[${operationName}] Connection or transient error: ${err.message}. Retrying in ${sleepDelay}ms... (Attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, sleepDelay));
          if ((isGroq ? apiKeyManager.getGroqKeyCount() : apiKeyManager.getGoogleKeyCount()) <= 1 || parsedDelay > 0) {
            delay *= 2;
          }
        }
      }
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  }

  private safeText(text: string, label: string, provider?: string): string {
    const isGroq = (provider || '').toLowerCase().trim() === 'groq';
    const limit = isGroq ? 20_000 : MAX_CHARS_PER_DOC;
    
    if (text.length <= limit) return text;
    logger.warn(
      'Comparison',
      `[${label}] Documento muy largo (${text.length} chars) para ${isGroq ? 'Groq' : 'Gemini'} — truncado a ${limit} chars.`
    );
    return text.substring(0, limit) + `\n\n[DOCUMENTO TRUNCADO para cumplir con los límites de la API de ${isGroq ? 'Groq' : 'Gemini'}]`;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async extractOntology(normativeText: string, provider?: string): Promise<OntologyItem[]> {
    const isGroq = (provider || '').toLowerCase().trim() === 'groq';
    logger.info('Comparison', `Extrayendo ontología del documento normativo con ${isGroq ? 'Groq Llama 3.3' : 'Gemini 2.5 Flash'}…`);
    const safeText = this.safeText(normativeText, 'Normativo', provider);

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
        model: isGroq ? 'groq/llama-3.3-70b-versatile' : MODEL_FLASH,
        prompt,
        output: { format: 'text' },
        config: { maxOutputTokens: isGroq ? 4096 : MAX_OUTPUT_TOKENS },
      },
      'extractOntology',
      provider
    );

    const rawText = response.text ?? '';
    const items = parseOntologyResponse(rawText);

    if (items.length === 0) {
      throw new Error('No se pudo extraer ningún ítem de la ontología normativa');
    }

    logger.info('Comparison', `✅ Ontología normativa extraída: ${items.length} elementos`);
    return items;
  }

  async extractProgramOntology(programText: string, provider?: string): Promise<OntologyItem[]> {
    const isGroq = (provider || '').toLowerCase().trim() === 'groq';
    logger.info('Comparison', `Extrayendo ontología del programa con ${isGroq ? 'Groq Llama 3.3' : 'Gemini 2.5 Flash'}…`);
    const safeText = this.safeText(programText, 'Programa', provider);

    const prompt = `Eres un experto en análisis de programas de materias universitarias (sílabos).

Analiza el siguiente programa de materia y extrae una lista normalizada y consolidada de sus secciones y contenidos principales.

INSTRUCCIONES CRÍTICAS DE NORMALIZACIÓN (LIMITACIÓN DE GRANULARIDAD):
1. Lee y analiza el documento completo.
2. Extrae únicamente los ítems principales de primer nivel. Por ejemplo: las unidades temáticas/contenidos principales (un ítem por unidad completa), los objetivos generales, la metodología docente principal, las actividades de evaluación clave y las bibliografías principales.
3. NO desgloses los subtemas o conceptos de cada unidad en múltiples ítems individuales. Cada unidad temática debe representarse como UN SOLO ítem en la lista.
4. El número total de ítems extraídos debe reflejar fielmente la estructura real del programa original y ser moderado (típicamente entre 15 y 35 ítems para un programa estándar). Bajo ninguna circunstancia generes más de 35 ítems en total. Evita extraer micro-conceptos individuales.
5. Asigna a cada ítem un ID secuencial (ej. PROG-001, PROG-002, etc.).
6. Categorías posibles: "Contenido", "Objetivo General", "Objetivo Específico", "Metodología", "Evaluación", "Bibliografía Obligatoria", "Bibliografía Complementaria", "Carga Horaria", "Correlativas", "Perfil del Graduado", "Proyectos Integradores".
7. Devuelve un JSON con la siguiente estructura exacta. No incluyas markdown, solo el JSON puro:

{"items": [
  {
    "id": "PROG-001",
    "category": "Contenido",
    "requirement": "Nombre de la unidad o sección de contenido principal",
    "description": "Descripción resumida y consolidada de los temas cubiertos en esta sección",
    "keywords": ["palabra1", "palabra2"]
  }
]}

PROGRAMA DE LA MATERIA:
${safeText}`;

    const response = await this.generateWithRetry(
      {
        model: isGroq ? 'groq/llama-3.3-70b-versatile' : MODEL_FLASH,
        prompt,
        output: { format: 'text' },
        config: { maxOutputTokens: isGroq ? 4096 : MAX_OUTPUT_TOKENS },
      },
      'extractProgramOntology',
      provider
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
    programOntology: OntologyItem[],
    normativeOntology: OntologyItem[],
    provider?: string
  ): Promise<ComparisonResult[]> {
    const isGroq = (provider || '').toLowerCase().trim() === 'groq';
    logger.info(
      'Comparison',
      `Comparando holísticamente en lotes con ${isGroq ? 'Groq Llama 3.3' : 'Gemini 2.5 Flash'}: ${programOntology.length} ítems de programa vs ${normativeOntology.length} normativos…`
    );

    const BATCH_SIZE = 100;
    const allResults: ComparisonResult[] = [];

    const normativeList = normativeOntology
      .map(
        (item) =>
          `- [${item.category}] ${item.requirement}: ${item.description} (Keywords: ${(item.keywords || []).join(', ')})`
      )
      .join('\n');

    for (let i = 0; i < programOntology.length; i += BATCH_SIZE) {
      if (i > 0) {
        logger.info('Comparison', 'Waiting 6 seconds to respect Gemini API rate limits (15/20 RPM)...');
        await new Promise((resolve) => setTimeout(resolve, 6000));
      }

      const batch = programOntology.slice(i, i + BATCH_SIZE);
      logger.info(
        'Comparison',
        `Procesando lote ${Math.floor(i / BATCH_SIZE) + 1} de ${Math.ceil(
          programOntology.length / BATCH_SIZE
        )} (${batch.length} ítems de programa)…`
      );

      const programList = batch
        .map(
          (item) =>
            `ID: ${item.id} | Categoría: ${item.category} | Ítem: ${item.requirement} | Descripción: ${item.description} | Keywords: ${(item.keywords || []).join(', ')}`
        )
        .join('\n');

      const prompt = `Eres un experto en evaluación de programas de materias universitarias y análisis de conformidad regulatoria.
Analiza la conformidad de los siguientes ${batch.length} ítems del programa de la materia frente al documento normativo de referencia.

Para CADA ítem del programa (hay exactamente ${batch.length}), determina:
- itemId: ID del ítem del programa (por ejemplo, ${batch[0]?.id})
- status: "covered" (el ítem del programa cumple plenamente con los requisitos y estándares normativos) | "partial" (el ítem cumple de manera parcial o incompleta con las regulaciones) | "missing" (el ítem del programa no cumple o está ausente de alineación con la normativa)
- confidence: número entre 0.0 y 1.0 que indica tu certeza
- evidence: 
  * Si está "covered" o "partial": cita textualmente o resume las secciones y requisitos específicos de la norma que respaldan, cubren o exigen este contenido/objetivo del programa.
  * Si está "missing": explica detalladamente por qué este contenido o aspecto del programa no cumple o no se alinea con las directivas de la norma de referencia.
- suggestion: recomendación pedagógica específica y aplicable para que este contenido o aspecto del programa se adecue plenamente a las directivas de la norma de referencia, o "Ninguna" si ya está en conformidad o no aplica.

REGLAS DE EVALUACIÓN SEMÁNTICA Y CONDICIONAL:
1. Usa razonamiento semántico avanzado: un ítem del programa puede estar alineado con la normativa conceptualmente aunque se exprese con terminología diferente.
2. DECLARACIONES NEGATIVAS O DE NO APLICABILIDAD: Si un requisito exige especificar, detallar o regular cierto aspecto y la guía docente/programa indica de manera explícita que NO aplica, que NO se concede, o que NINGUNA actividad/recurso está sujeto a ello, este aspecto se debe evaluar como "covered" (cubierto) y NO como "missing" o "partial".

Devuelve un JSON con la siguiente estructura exacta. No incluyas markdown, solo el JSON puro:

{"results": [
  {
    "itemId": "PROG-CONT-001",
    "status": "covered",
    "confidence": 0.9,
    "evidence": "...",
    "suggestion": "Ninguna"
  }
]}

═══════════════════════════════════════════════════════════
ÍTEMS DEL PROGRAMA A EVALUAR (${batch.length} items):
═══════════════════════════════════════════════════════════
${programList}

═══════════════════════════════════════════════════════════
REQUISITOS NORMATIVOS DE REFERENCIA (${normativeOntology.length} items):
═══════════════════════════════════════════════════════════
${normativeList}`;

      const response = await this.generateWithRetry(
        {
          model: isGroq ? 'groq/llama-3.3-70b-versatile' : MODEL_FLASH,
          prompt,
          output: { format: 'text' },
          config: { maxOutputTokens: isGroq ? 4096 : MAX_OUTPUT_TOKENS },
        },
        `compareOntologies_batch_${Math.floor(i / BATCH_SIZE) + 1}`,
        provider
      );

      const rawText = response.text ?? '';
      const rawResults = parseComparisonResponse(rawText);

      // Diagnostic: log first 500 chars of model response + parsed field names
      if (rawResults.length > 0) {
        const sampleKeys = Object.keys(rawResults[0]).join(', ');
        logger.info('Comparison', `Lote ${Math.floor(i / BATCH_SIZE) + 1}: primer resultado tiene campos: [${sampleKeys}]. Primer itemId: "${rawResults[0].itemId ?? rawResults[0].item_id ?? rawResults[0].id ?? 'N/A'}"`);
      } else {
        logger.warn('Comparison', `Lote ${Math.floor(i / BATCH_SIZE) + 1}: parseComparisonResponse devolvió 0 resultados. Primeros 500 chars del raw: ${rawText.substring(0, 500)}`);
      }

      logger.info(
        'Comparison',
        `Lote ${Math.floor(i / BATCH_SIZE) + 1}: modelo devolvió ${rawResults.length} resultados parseados para ${batch.length} ítems de programa`
      );

      // Build a normalized lookup map: normalize IDs for case-insensitive,
      // whitespace-insensitive, and separator-insensitive matching.
      const normalizeId = (id: string) => id.trim().toLowerCase().replace(/[\s_]+/g, '-');

      const batchMap = new Map<string, OntologyItem>();
      for (const item of batch) {
        batchMap.set(normalizeId(item.id), item);
      }

      // Map model results to batch items using normalized ID matching
      const matchedResults = new Map<string, ComparisonResult>();

      for (const r of rawResults) {
        // The model might use different field names for the ID
        const rawId = r.itemId ?? r.item_id ?? r.id ?? r.reqId ?? r.req_id ?? '';
        const status = r.status;
        if (!rawId || !status) continue;

        const normId = normalizeId(rawId);
        const item = batchMap.get(normId);

        if (!item) {
          logger.warn(
            'Comparison',
            `ID del modelo "${rawId}" (normalizado: "${normId}") no coincide con ningún ítem del lote. IDs esperados: ${batch.slice(0, 5).map(b => b.id).join(', ')}...`
          );
          continue;
        }

        matchedResults.set(item.id, {
          item,
          status: normalizeStatus(r.status),
          confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
          evidence: String(r.evidence ?? ''),
          suggestion: String(r.suggestion ?? ''),
        });
      }

      logger.info(
        'Comparison',
        `Lote ${Math.floor(i / BATCH_SIZE) + 1}: ${matchedResults.size}/${batch.length} ítems mapeados exitosamente`
      );

      // Ensure every batch item has a result
      for (const item of batch) {
        const found = matchedResults.get(item.id);
        if (found) {
          allResults.push(found);
        } else {
          logger.warn('Comparison', `Sin resultado del modelo para: ${item.id} (${item.requirement})`);
          allResults.push({
            item,
            status: 'missing',
            confidence: 0.0,
            evidence: 'No se obtuvo respuesta del modelo de lenguaje para este ítem del programa durante el procesamiento.',
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
    programName: string,
    provider?: string,
    onProgress?: (content: string) => void
  ): Promise<ComparisonReport> {
    logger.info('Comparison', `Iniciando comparación: "${normativeName}" vs "${programName}" con proveedor: ${provider || 'default'}`);
    logger.info('Comparison', `Normativo: ${normativeText.length} chars | Programa: ${programText.length} chars`);

    onProgress?.('Extrayendo ontología del documento normativo...');
    const ontology        = await this.extractOntology(normativeText, provider);
    
    onProgress?.('Extrayendo ontología del programa...');
    const programOntology = await this.extractProgramOntology(programText, provider);
    
    onProgress?.('Comparando los ítems del programa con la normativa...');
    // The program items define the ontology to be controlled (checklist)
    const results         = await this.compareOntologies(programOntology, ontology, provider);

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
      ontology: programOntology,
      programOntology: ontology,
      results,
      summary: { total, covered, partial, missing, coveragePercent },
      timestamp: new Date().toISOString(),
      normativeText,
      programText,
    };
  }
}
