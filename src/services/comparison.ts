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
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Handle escape sequences inside strings
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    // Skip everything inside strings
    if (inString) continue;

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
  if (!obj || typeof obj !== 'object') return false;
  // Accept various field names the LLM might use for the ID
  const hasId = typeof obj.id === 'string' || typeof obj.itemId === 'string' || typeof obj.item_id === 'string' || typeof obj.reqId === 'string';
  // Accept various field names for the requirement/content text
  const hasReq = typeof obj.requirement === 'string' || typeof obj.name === 'string' ||
    typeof obj.title === 'string' || typeof obj.content === 'string' ||
    typeof obj.topic === 'string' || typeof obj.tema === 'string' ||
    typeof obj.requisito === 'string' || typeof obj.description === 'string';
  return hasId && hasReq;
}

function normalizeOntologyItem(obj: any): OntologyItem {
  const id = String(obj.id ?? obj.itemId ?? obj.item_id ?? obj.reqId ?? '');
  const requirement = String(obj.requirement ?? obj.name ?? obj.title ?? obj.content ?? obj.topic ?? obj.tema ?? obj.requisito ?? obj.description ?? '');
  return {
    id,
    category:    String(obj.category ?? obj.categoria ?? obj.type ?? obj.tipo ?? 'General'),
    requirement,
    description: String(obj.description ?? obj.descripcion ?? requirement ?? ''),
    keywords:    Array.isArray(obj.keywords) ? obj.keywords.map(String) : (Array.isArray(obj.palabras_clave) ? obj.palabras_clave.map(String) : []),
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
    const normProvider = (provider || '').toLowerCase().trim();
    const isGroq = normProvider === 'groq';
    const isGroqFast = normProvider === 'groq-fast';

    let modelName = options.model || 'googleai/gemini-2.5-flash';
    let systemName = 'gemini';
    if (isGroq) {
      modelName = 'llama-3.3-70b-versatile';
      systemName = 'groq';
    } else if (isGroqFast) {
      modelName = 'llama-3.1-8b-instant';
      systemName = 'groq';
    }

    let attempt = 0;
    const maxRetries = 8;
    let delay = (isGroq || isGroqFast) ? 3000 : 5000;

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
          if (isGroq || isGroqFast) {
            const apiKey = apiKeyManager.getCurrentGroqKey();
            if (!apiKey) {
              throw new Error('GROQ_API_KEY is not defined in the environment or ApiKeyManager.');
            }
            const activeModel = isGroqFast ? 'llama-3.1-8b-instant' : 'llama-3.3-70b-versatile';
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                model: activeModel,
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
    const normProvider = (provider || '').toLowerCase().trim();
    const isGroq = normProvider === 'groq';
    const isGroqFast = normProvider === 'groq-fast';
    
    const limit = isGroq ? 20_000 : (isGroqFast ? 12_000 : MAX_CHARS_PER_DOC);
    const providerLabel = isGroq ? 'Groq Llama 3.3' : (isGroqFast ? 'Groq Llama 3.1' : 'Gemini');
    
    if (text.length <= limit) return text;
    logger.warn(
      'Comparison',
      `[${label}] Documento muy largo (${text.length} chars) para ${providerLabel} — truncado a ${limit} chars.`
    );
    return text.substring(0, limit) + `\n\n[DOCUMENTO TRUNCADO para cumplir con los límites de la API de ${providerLabel}]`;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async extractOntology(normativeText: string, provider?: string): Promise<OntologyItem[]> {
    const normProvider = (provider || '').toLowerCase().trim();
    const isGroq = normProvider === 'groq';
    const isGroqFast = normProvider === 'groq-fast';
    const providerLabel = isGroq ? 'Groq Llama 3.3' : (isGroqFast ? 'Groq Llama 3.1' : 'Gemini 2.5 Flash');
    logger.info('Comparison', `Extrayendo ontología del documento normativo con ${providerLabel}…`);
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

    const maxTokens = isGroq ? 4096 : (isGroqFast ? 1536 : MAX_OUTPUT_TOKENS);
    const response = await this.generateWithRetry(
      {
        model: isGroq ? 'groq/llama-3.3-70b-versatile' : (isGroqFast ? 'groq/llama-3.1-8b-instant' : MODEL_FLASH),
        prompt,
        output: { format: 'text' },
        config: { maxOutputTokens: maxTokens },
      },
      'extractOntology',
      provider
    );

    const rawText = response.text ?? '';
    let items = parseOntologyResponse(rawText);

    if (items.length === 0) {
      // Log the raw response for debugging before retrying
      logger.warn('Comparison', `extractOntology: primera respuesta del LLM no produjo ítems válidos. Raw response (primeros 1000 chars): ${rawText.substring(0, 1000)}`);
      logger.info('Comparison', `extractOntology: reintentando con prompt reforzado...`);

      // Retry with a more explicit prompt
      const retryPrompt = `INSTRUCCIÓN CRÍTICA: Debes responder ÚNICAMENTE con un JSON válido. No incluyas explicaciones, comentarios ni markdown.

Devuelve un array JSON con la siguiente estructura EXACTA:
[{"id": "REQ-001", "category": "Contenido Mínimo", "requirement": "texto del requisito", "description": "descripción", "keywords": ["kw1"]}]

Analiza el siguiente documento normativo y extrae TODOS los requisitos:

${safeText}`;

      const retryResponse = await this.generateWithRetry(
        {
          model: isGroq ? 'groq/llama-3.3-70b-versatile' : (isGroqFast ? 'groq/llama-3.1-8b-instant' : MODEL_FLASH),
          prompt: retryPrompt,
          output: { format: 'text' },
          config: { maxOutputTokens: maxTokens },
        },
        'extractOntology_retry',
        provider
      );

      const retryRawText = retryResponse.text ?? '';
      items = parseOntologyResponse(retryRawText);

      if (items.length === 0) {
        logger.error('Comparison', `extractOntology: segundo intento también falló. Raw retry response (primeros 1000 chars): ${retryRawText.substring(0, 1000)}`, new Error('Ontology extraction failed after retry'));
        throw new Error('No se pudo extraer ningún ítem de la ontología normativa (incluso tras reintentar con prompt reforzado)');
      }
      logger.info('Comparison', `✅ Ontología normativa extraída en segundo intento: ${items.length} elementos`);
    } else {
      logger.info('Comparison', `✅ Ontología normativa extraída: ${items.length} elementos`);
    }
    return items;
  }

  async extractProgramOntology(programText: string, provider?: string): Promise<OntologyItem[]> {
    const normProvider = (provider || '').toLowerCase().trim();
    const isGroq = normProvider === 'groq';
    const isGroqFast = normProvider === 'groq-fast';
    const providerLabel = isGroq ? 'Groq Llama 3.3' : (isGroqFast ? 'Groq Llama 3.1' : 'Gemini 2.5 Flash');
    logger.info('Comparison', `Extrayendo ontología del programa con ${providerLabel}…`);
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

    const maxTokens = isGroq ? 4096 : (isGroqFast ? 1536 : MAX_OUTPUT_TOKENS);
    const response = await this.generateWithRetry(
      {
        model: isGroq ? 'groq/llama-3.3-70b-versatile' : (isGroqFast ? 'groq/llama-3.1-8b-instant' : MODEL_FLASH),
        prompt,
        output: { format: 'text' },
        config: { maxOutputTokens: maxTokens },
      },
      'extractProgramOntology',
      provider
    );

    const rawText = response.text ?? '';
    let items = parseOntologyResponse(rawText);

    if (items.length === 0) {
      // Log the raw response for debugging before retrying
      logger.warn('Comparison', `extractProgramOntology: primera respuesta del LLM no produjo ítems válidos. Raw response (primeros 1000 chars): ${rawText.substring(0, 1000)}`);
      logger.info('Comparison', `extractProgramOntology: reintentando con prompt reforzado...`);

      // Retry with a more explicit prompt
      const retryPrompt = `INSTRUCCIÓN CRÍTICA: Debes responder ÚNICAMENTE con un JSON válido. No incluyas explicaciones, comentarios ni markdown.

Devuelve un array JSON con la siguiente estructura EXACTA:
[{"id": "PROG-001", "category": "Contenido", "requirement": "nombre de la sección", "description": "descripción", "keywords": ["kw1"]}]

Analiza el siguiente programa de materia y extrae las secciones principales (unidades, objetivos, metodología, evaluación, bibliografía). Máximo 35 ítems.

${safeText}`;

      const retryResponse = await this.generateWithRetry(
        {
          model: isGroq ? 'groq/llama-3.3-70b-versatile' : (isGroqFast ? 'groq/llama-3.1-8b-instant' : MODEL_FLASH),
          prompt: retryPrompt,
          output: { format: 'text' },
          config: { maxOutputTokens: maxTokens },
        },
        'extractProgramOntology_retry',
        provider
      );

      const retryRawText = retryResponse.text ?? '';
      items = parseOntologyResponse(retryRawText);

      if (items.length === 0) {
        logger.error('Comparison', `extractProgramOntology: segundo intento también falló. Raw retry response (primeros 1000 chars): ${retryRawText.substring(0, 1000)}`, new Error('Program ontology extraction failed after retry'));
        throw new Error('No se pudo extraer ningún ítem de la ontología del programa (incluso tras reintentar con prompt reforzado)');
      }
      logger.info('Comparison', `✅ Ontología del programa extraída en segundo intento: ${items.length} elementos`);
    } else {
      logger.info('Comparison', `✅ Ontología del programa extraída: ${items.length} elementos`);
    }
    return items;
  }

  async compareOntologies(
    normativeOntology: OntologyItem[],
    programOntology: OntologyItem[],
    provider?: string
  ): Promise<ComparisonResult[]> {
    const normProvider = (provider || '').toLowerCase().trim();
    const isGroq = normProvider === 'groq';
    const isGroqFast = normProvider === 'groq-fast';
    const providerLabel = isGroq ? 'Groq Llama 3.3' : (isGroqFast ? 'Groq Llama 3.1' : 'Gemini 2.5 Flash');
    logger.info(
      'Comparison',
      `Comparando holísticamente en lotes con ${providerLabel}: ${normativeOntology.length} requisitos normativos vs ${programOntology.length} ítems del programa…`
    );

    const BATCH_SIZE = 50; // Reduce batch size slightly to improve semantic match accuracy per batch
    const allResults: ComparisonResult[] = [];

    // Format the entire program ontology once as reference text
    const programList = programOntology
      .map(
        (item) =>
          `- [${item.category}] ${item.requirement}: ${item.description} (Keywords: ${(item.keywords || []).join(', ')})`
      )
      .join('\n');

    for (let i = 0; i < normativeOntology.length; i += BATCH_SIZE) {
      if (i > 0) {
        const waitLabel = (isGroq || isGroqFast) ? 'Groq' : 'Gemini';
        logger.info('Comparison', `Waiting 6 seconds to respect ${waitLabel} API rate limits...`);
        await new Promise((resolve) => setTimeout(resolve, 6000));
      }

      const batch = normativeOntology.slice(i, i + BATCH_SIZE);
      logger.info(
        'Comparison',
        `Procesando lote ${Math.floor(i / BATCH_SIZE) + 1} de ${Math.ceil(
          normativeOntology.length / BATCH_SIZE
        )} (${batch.length} requisitos normativos)…`
      );

      const normativeList = batch
        .map(
          (item) =>
            `ID: ${item.id} | Categoría: ${item.category} | Requisito: ${item.requirement} | Descripción: ${item.description} | Keywords: ${(item.keywords || []).join(', ')}`
        )
        .join('\n');

      const prompt = `Eres un experto en evaluación de programas de materias universitarias y análisis de conformidad regulatoria de planes de estudio y guías docentes frente a rúbricas de acreditación.
Analiza si el programa de la materia cumple con los siguientes ${batch.length} requisitos normativos de la rúbrica de referencia.

Para CADA requisito normativo de la lista (hay exactamente ${batch.length}), determina:
- itemId: ID del requisito normativo a evaluar (por ejemplo, ${batch[0]?.id})
- status: 
  * "covered": el programa de la materia cumple plenamente con el requisito de la rúbrica (ya sea de forma explícita o por equivalencia conceptual clara).
  * "partial": el programa cumple el requisito normativo de forma parcial, incompleta, vaga, ambigua o insuficiente.
  * "missing": el requisito de la rúbrica/normativa no está cubierto, está ausente, no se menciona o la información clave requerida falta por completo en el programa.
- confidence: número entre 0.0 y 1.0 que indica tu certeza
- evidence: 
  * Si está "covered" o "partial": cita textualmente o resume las secciones del programa de la materia que cubren este requisito normativo.
  * Si está "missing": explica detalladamente qué información o elemento regulatorio de la rúbrica (como homologabilidad, carga horaria, contenidos mínimos, etc.) está ausente en el programa.
- suggestion: recomendación pedagógica y administrativa concreta para incorporar el texto o corregir el programa de la materia a fin de satisfacer plenamente el requisito. Si ya cumple plenamente, responde "Ninguna".

REGLAS DE EVALUACIÓN SEMÁNTICA Y CONDICIONAL:
1. Usa razonamiento semántico avanzado: un requisito puede estar cubierto conceptualmente aunque se exprese con terminología diferente en el programa.
2. DECLARACIONES NEGATIVAS O DE NO APLICABILIDAD: Si un requisito exige especificar o detallar cierto aspecto y el programa indica explícitamente que no aplica, este aspecto se debe evaluar como "covered" y NO como "missing" o "partial".
3. REQUISITOS DE DISEÑO DE PLAN / HOMOLOGACIÓN: Si el requisito exige datos administrativos de la carrera o el plan (carga horaria total de la carrera, perfil del graduado, homologación, etc.) y estos no figuran en el programa de la materia evaluada, indícalo como "missing" o "partial" según corresponda.

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
REQUISITOS NORMATIVOS/RÚBRICA A EVALUAR (${batch.length} items):
═══════════════════════════════════════════════════════════
${normativeList}

═══════════════════════════════════════════════════════════
CONTENIDO Y ESTRUCTURA DEL PROGRAMA DE REFERENCIA:
═══════════════════════════════════════════════════════════
${programList}`;

      const maxTokens = isGroq ? 4096 : (isGroqFast ? 1536 : MAX_OUTPUT_TOKENS);
      const response = await this.generateWithRetry(
        {
          model: isGroq ? 'groq/llama-3.3-70b-versatile' : (isGroqFast ? 'groq/llama-3.1-8b-instant' : MODEL_FLASH),
          prompt,
          output: { format: 'text' },
          config: { maxOutputTokens: maxTokens },
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
        `Lote ${Math.floor(i / BATCH_SIZE) + 1}: modelo devolvió ${rawResults.length} resultados parseados para ${batch.length} requisitos normativos`
      );

      // Build a normalized lookup map
      const normalizeId = (id: string) => id.trim().toLowerCase().replace(/[\s_]+/g, '-');

      const batchMap = new Map<string, OntologyItem>();
      for (const item of batch) {
        batchMap.set(normalizeId(item.id), item);
      }

      // Map model results to batch items using normalized ID matching
      const matchedResults = new Map<string, ComparisonResult>();

      for (const r of rawResults) {
        const rawId = r.itemId ?? r.item_id ?? r.id ?? r.reqId ?? r.req_id ?? '';
        const status = r.status;
        if (!rawId || !status) continue;

        const normId = normalizeId(rawId);
        const item = batchMap.get(normId);

        if (!item) {
          logger.warn(
            'Comparison',
            `ID del modelo "${rawId}" (normalizado: "${normId}") no coincide con ningún requisito normativo del lote. IDs esperados: ${batch.slice(0, 5).map(b => b.id).join(', ')}...`
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
        `Lote ${Math.floor(i / BATCH_SIZE) + 1}: ${matchedResults.size}/${batch.length} requisitos normativos mapeados exitosamente`
      );

      // Ensure every batch item has a result
      for (const item of batch) {
        const found = matchedResults.get(item.id);
        if (found) {
          allResults.push(found);
        } else {
          logger.warn('Comparison', `Sin resultado del modelo para requisito: ${item.id} (${item.requirement})`);
          allResults.push({
            item,
            status: 'missing',
            confidence: 0.0,
            evidence: 'No se obtuvo respuesta del modelo de lenguaje para este requisito normativo durante el procesamiento.',
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
    
    onProgress?.('Comparando la normativa con el programa...');
    // We evaluate the normative requirements (ontology) against the program ontology
    const results         = await this.compareOntologies(ontology, programOntology, provider);

    const covered = results.filter((r) => r.status === 'covered').length;
    const partial = results.filter((r) => r.status === 'partial').length;
    const missing = results.filter((r) => r.status === 'missing').length;
    const total   = results.length;

    const coveragePercent = total > 0
      ? Math.round(((covered + partial * 0.5) / total) * 100)
      : 0;

    logger.info(
      'Comparison',
      `📊 Resumen de Comparación: ${covered} cubiertos | ${partial} parciales | ${missing} faltantes | Cumplimiento: ${coveragePercent}%`
    );

    return {
      normativeDocument: normativeName,
      programDocument: programName,
      ontology, // normative ontology (stored as ontology in the database schema)
      programOntology, // program ontology (stored as programOntology in the database schema)
      results,
      summary: { total, covered, partial, missing, coveragePercent },
      timestamp: new Date().toISOString(),
      normativeText,
      programText,
    };
  }
}
