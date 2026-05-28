/**
 * POST /api/rubric — Generates a holistic rubric from a normative PDF.
 *
 * Produces a rubric with 3 compliance levels:
 *   - Cumple Totalmente (2 pts) → ÓPTIMO
 *   - Cumple Parcialmente (1 pt) → ACEPTABLE CON OBSERVACIÓN
 *   - No Cumple (0 pts) → DEFICIENTE / CRÍTICO
 *
 * Workflow:
 *   1. Receives the normative PDF via multipart/form-data.
 *   2. Extracts text with pdf-parse.
 *   3. Extracts the ontology with ComparisonService.extractOntology().
 *   4. Sends the ontology to Gemini to generate a holistic rubric.
 *   5. Returns JSON with the rubric data + a base64-encoded PDF.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../lib/services';
import { createLogger } from '../../services/logger';
import { generateRubricPDF } from '../../services/rubric-pdf-generator';
import pdfParse from 'pdf-parse';
import { genkit } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { Agent, setGlobalDispatcher } from 'undici';
import { retryWithBackoff } from '../../utils/retry';

// Configure global dispatcher for long requests
setGlobalDispatcher(new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
  keepAliveTimeout: 60_000,
  connections: 20,
}));

const logger = createLogger();

// ── Rubric types ──

export interface RubricCriterion {
  id: string;
  dimension: string;
  criterion: string;
  description: string;
  levels: {
    /** Cumple Totalmente (2 pts) — ÓPTIMO */
    full: string;
    /** Cumple Parcialmente (1 pt) — ACEPTABLE CON OBSERVACIÓN */
    partial: string;
    /** No Cumple (0 pts) — DEFICIENTE / CRÍTICO */
    none: string;
  };
}

export interface RubricData {
  title: string;
  subtitle: string;
  normativeDocument: string;
  criteria: RubricCriterion[];
  totalWeight: number;
  generatedAt: string;
}

// ── JSON recovery helpers ──

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
        } catch { /* skip malformed */ }
        start = -1;
      }
    }
  }
  return objects;
}

function parseRubricResponse(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();

  // 1. Try full parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed?.criteria && Array.isArray(parsed.criteria)) {
      return parsed;
    }
  } catch { /* fall through */ }

  // 2. Try extracting inner object
  const objects = extractCompleteObjects(cleaned);
  for (const obj of objects) {
    if (obj?.criteria && Array.isArray(obj.criteria)) {
      return obj;
    }
  }

  // 3. Try to find the array of criteria
  const arrMatch = cleaned.match(/"criteria"\s*:\s*\[/);
  if (arrMatch) {
    const arrStart = cleaned.indexOf('[', arrMatch.index ?? 0);
    const criteriaText = cleaned.substring(arrStart);
    const criteriaObjects = extractCompleteObjects(criteriaText);
    if (criteriaObjects.length > 0) {
      return {
        title: 'Rúbrica Integral de Evaluación',
        subtitle: '',
        criteria: criteriaObjects,
      };
    }
  }

  return null;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const { comparisonService, graphBuilder, config } = await getServices();
    const formData = await request.formData();
    const normFile = formData.get('normative') as File | null;

    if (!normFile) {
      return new Response(JSON.stringify({ success: false, error: 'Se requiere un archivo PDF normativo' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('Rubric', `Generating rubric from: ${normFile.name}`);

    // 1. Extract text
    const normBuffer = Buffer.from(await normFile.arrayBuffer());
    const normPdf = await pdfParse(normBuffer);

    if (!normPdf.text?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'No se pudo extraer texto del documento normativo' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Extract ontology
    logger.info('Rubric', 'Extracting ontology...');
    const ontology = await comparisonService.extractOntology(normPdf.text);
    logger.info('Rubric', `Ontology extracted: ${ontology.length} items`);

    // 3. Generate rubric with Gemini
    logger.info('Rubric', 'Generating holistic rubric with Gemini...');

    const ai = genkit({
      plugins: [googleAI({ apiKey: config.google.apiKey })],
    });

    const ontologyList = ontology.map(item =>
      `- [${item.category}] ${item.id}: ${item.requirement} — ${item.description} (Keywords: ${(item.keywords || []).join(', ')})`
    ).join('\n');

    const prompt = `Eres un experto en diseño curricular, evaluación educativa, acreditación universitaria y auditoría de programas.

A partir de la siguiente ontología de requisitos normativos, genera una RÚBRICA INTEGRAL DE EVALUACIÓN para la auditoría y revisión de programas de materia y aulas virtuales.

La rúbrica debe tener EXACTAMENTE 3 NIVELES DE CUMPLIMIENTO:
- "Cumple Totalmente" (2 puntos) → Etiquetado como ÓPTIMO
- "Cumple Parcialmente" (1 punto) → Etiquetado como ACEPTABLE CON OBSERVACIÓN
- "No Cumple" (0 puntos) → Etiquetado como DEFICIENTE / CRÍTICO

INSTRUCCIONES DETALLADAS:
1. Agrupa los requisitos en DIMENSIONES temáticas (ej: "Coherencia Político-Normativa e Institucional", "Estructura Organizativa", "Diseño Didáctico y Mediaciones", "Evaluación y Seguimiento", etc.).
2. Dentro de cada dimensión, define COMPONENTES EVALUADOS específicos (ej: "1.1 Límite de Carga Horaria Virtual", "1.2 Consistencia con el Programa Oficial", etc.).
3. Cada componente debe tener:
   - Un ID numérico con formato "X.Y" (dimensión.componente)
   - Un nombre descriptivo del componente evaluado
   - Un "Criterio de Calidad Institucional": descripción detallada de qué se evalúa y por qué
   - Tres niveles de cumplimiento con descriptores DETALLADOS y ESPECÍFICOS:
     * "full": Descriptor ÓPTIMO — qué evidencia se encuentra cuando cumple totalmente
     * "partial": Descriptor ACEPTABLE CON OBSERVACIÓN — qué se encuentra cuando cumple parcialmente
     * "none": Descriptor DEFICIENTE/CRÍTICO — qué se encuentra cuando no cumple
4. Los descriptores de cada nivel deben ser CONCRETOS y ESPECÍFICOS (no genéricos), describiendo exactamente qué evidencia buscar.
5. Referencia las normativas originales cuando sea posible (resoluciones, artículos, etc.).

Devuelve un JSON con la siguiente estructura exacta. No incluyas markdown, solo el JSON puro:

{
  "title": "Rúbrica Integral para la Auditoría y Revisión de Programas",
  "subtitle": "EVALUACIÓN DE CUMPLIMIENTO DE NORMATIVA — Generada automáticamente",
  "criteria": [
    {
      "id": "1.1",
      "dimension": "Coherencia Político-Normativa e Institucional",
      "criterion": "Nombre del Componente Evaluado",
      "description": "Criterio de calidad institucional detallado que explica qué se verifica y por qué es importante",
      "levels": {
        "full": "ÓPTIMO — Descriptor detallado de cumplimiento total con evidencias específicas",
        "partial": "ACEPTABLE CON OBSERVACIÓN — Descriptor de cumplimiento parcial con las deficiencias detectables",
        "none": "DEFICIENTE / CRÍTICO — Descriptor de incumplimiento con las falencias críticas"
      }
    }
  ]
}

═══════════════════════════════════════════════════════════
ONTOLOGÍA DE REQUISITOS NORMATIVOS (${ontology.length} items):
═══════════════════════════════════════════════════════════
${ontologyList}`;

    const response = await retryWithBackoff(
      async () => ai.generate({
        model: 'googleai/gemini-2.5-flash',
        prompt,
        output: { format: 'text' },
        config: { maxOutputTokens: 65_536 },
      }),
      {
        maxRetries: 5,
        initialDelayMs: 15_000,
        maxDelayMs: 90_000,
        component: 'RubricAPI',
        operationName: 'generateRubric',
        logger,
      }
    );

    const rawText = response.text ?? '';
    const rubricRaw = parseRubricResponse(rawText);

    if (!rubricRaw || !rubricRaw.criteria || rubricRaw.criteria.length === 0) {
      throw new Error('No se pudo generar la rúbrica a partir de la ontología');
    }

    // Normalize criteria
    const criteria: RubricCriterion[] = rubricRaw.criteria.map((c: any, idx: number) => ({
      id: c.id || `${Math.floor(idx / 3) + 1}.${(idx % 3) + 1}`,
      dimension: c.dimension || 'General',
      criterion: c.criterion || c.name || '',
      description: c.description || '',
      levels: {
        full: c.levels?.full || c.levels?.cumple_totalmente || c.levels?.excellent || '',
        partial: c.levels?.partial || c.levels?.cumple_parcialmente || c.levels?.acceptable || '',
        none: c.levels?.none || c.levels?.no_cumple || c.levels?.insufficient || '',
      },
    }));

    // Total weight: 2 points per criterion
    const totalWeight = criteria.length * 2;

    const rubric: RubricData = {
      title: rubricRaw.title || 'Rúbrica Integral para la Auditoría y Revisión de Programas',
      subtitle: rubricRaw.subtitle || 'EVALUACIÓN DE CUMPLIMIENTO DE NORMATIVA',
      normativeDocument: normFile.name,
      criteria,
      totalWeight,
      generatedAt: new Date().toISOString(),
    };

    logger.info('Rubric', `✅ Rubric generated: ${criteria.length} criteria, max score: ${totalWeight} pts`);

    // 4. Generate PDF
    const pdfBuffer = await generateRubricPDF(rubric);
    const pdfBase64 = pdfBuffer.toString('base64');

    // 5. Persist to Neo4j database
    logger.info('Rubric', 'Persisting generated rubric to Neo4j...');
    await graphBuilder.saveRubric(rubric, pdfBase64);

    return new Response(JSON.stringify({
      success: true,
      data: rubric,
      pdfBase64,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    logger.error('Rubric', 'Error generating rubric', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * GET /api/rubric — Retrieves the latest persisted rubric from Neo4j.
 */
export const GET: APIRoute = async () => {
  try {
    const { graphBuilder } = await getServices();
    logger.info('Rubric', 'Fetching latest rubric from Neo4j...');
    const result = await graphBuilder.getLatestRubric();

    if (!result) {
      return new Response(JSON.stringify({ success: true, data: null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      data: result.rubric,
      pdfBase64: result.pdfBase64,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('Rubric', 'Error fetching latest rubric', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * DELETE /api/rubric — Clears all rubrics from Neo4j.
 */
export const DELETE: APIRoute = async () => {
  try {
    const { graphBuilder } = await getServices();
    logger.info('Rubric', 'Clearing all rubrics from Neo4j...');
    await graphBuilder.clearRubrics();
    return new Response(JSON.stringify({ success: true, message: 'Rúbricas eliminadas.' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('Rubric', 'Error clearing rubrics', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

