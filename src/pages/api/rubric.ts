/**
 * POST /api/rubric — Multi-agent rubric generation from 2 input PDFs.
 *
 * Inputs (multipart/form-data):
 *   - normative:        PDF normativo (resolución, ordenanza)
 *   - evaluationSchema: PDF con el esquema de aspectos evaluables
 *
 * Workflow:
 *   1. Extract text from both PDFs.
 *   2. Extract normative ontology → store in Neo4j (:OntologyItem nodes).
 *   3. Extract evaluation schema aspects → store in Neo4j (:EvaluableAspect nodes).
 *   4. Run 3-agent pipeline (OntologyAnalyzer → SchemaOntologyAdjuster → RubricSynthesizer).
 *   5. Parse rubric JSON from the synthesizer agent output.
 *   6. Generate PDF + persist to Neo4j.
 *   7. Return JSON + base64 PDF.
 *
 * GET  /api/rubric — Retrieves the latest persisted rubric from Neo4j.
 * DELETE /api/rubric — Clears all rubric data from Neo4j.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../lib/services';
import { createLogger } from '../../services/logger';
import { generateRubricPDF } from '../../services/rubric-pdf-generator';
import { runRubricPipeline } from '../../services/rubric-agent-service';
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
  schemaAspectId?: string;
  normativeRefs?: string[];
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
  nonEvaluableObservations?: Array<{
    aspect: string;
    reason: string;
    recommendation: string;
  }>;
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

// ── Helper: extract evaluation schema aspects from text ──

async function extractSchemaAspects(
  text: string,
  config: any,
  provider?: string
): Promise<Array<{ id: string; aspect: string; description: string; category: string }>> {
  const isGroq = (provider || '').toLowerCase().trim() === 'groq';
  const limit = isGroq ? 20_000 : 100_000;

  const prompt = `Analiza el siguiente documento que define el esquema de evaluación (estructura / aspectos que debe cubrir una guía docente).

Extraé TODOS los aspectos evaluables que figuran en el documento. Cada aspecto es un punto que la rúbrica de evaluación debe verificar.

Para cada aspecto, devolvé:
- "id": Un ID único (ej: "ASP-001", "ASP-002", etc.)
- "aspect": Nombre del aspecto evaluable
- "description": Descripción detallada de qué se evalúa
- "category": Categoría/dimensión temática (ej: "Datos Institucionales", "Objetivos", "Contenidos", "Metodología", "Evaluación", "Bibliografía", "Carga Horaria", etc.)

Devuelve un JSON con esta estructura. No incluyas markdown, solo el JSON puro:
{"aspects": [{"id": "ASP-001", "aspect": "...", "description": "...", "category": "..."}]}

DOCUMENTO DE ESQUEMA DE EVALUACIÓN:
${text.substring(0, limit)}`;

  const response = await retryWithBackoff(
    async () => {
      if (isGroq) {
        const apiKey = process.env.GROQ_API_KEY || '';
        if (!apiKey) {
          throw new Error('GROQ_API_KEY is not defined in the environment.');
        }
        logger.info('RubricAPI', 'Calling Groq API via fetch for extractSchemaAspects...');
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 4096,
          })
        });
        
        if (res.status === 413 || res.status === 429) {
          logger.warn('RubricAPI', `Groq rate/context limit hit (status ${res.status}). Waiting 30 seconds before retrying...`);
          await new Promise(resolve => setTimeout(resolve, 30000));
          throw new Error(`Groq rate limit (${res.status}) hit in rubric extraction, retrying.`);
        }
        
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Groq API returned error status ${res.status}: ${errText}`);
        }
        const json = await res.json() as any;
        const content = json.choices?.[0]?.message?.content || '';
        return { text: content };
      } else {
        const ai = genkit({ plugins: [googleAI({ apiKey: config.google.apiKey })] });
        return ai.generate({
          model: 'googleai/gemini-3.5-flash',
          prompt,
          output: { format: 'text' },
          config: { maxOutputTokens: 32_768 },
        });
      }
    },
    {
      maxRetries: 3,
      initialDelayMs: 10_000,
      maxDelayMs: 60_000,
      component: 'RubricAPI',
      operationName: 'extractSchemaAspects',
      logger,
    }
  );

  const raw = response.text ?? '';
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed.aspects || [];
  } catch {
    return extractCompleteObjects(cleaned).filter(o => o.id && o.aspect);
  }
}

// ── POST ────────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  try {
    const { comparisonService, graphBuilder, config } = await getServices();
    const formData = await request.formData();

    const normFile = formData.get('normative') as File | null;
    const schemaFile = formData.get('evaluationSchema') as File | null;
    const provider = formData.get('provider') as string | null || undefined;

    if (!normFile || !schemaFile) {
      const missing = [];
      if (!normFile) missing.push('documento normativo');
      if (!schemaFile) missing.push('esquema de evaluación');
      return new Response(JSON.stringify({
        success: false,
        error: `Faltan archivos: ${missing.join(', ')}`
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    logger.info('Rubric', `Multi-agent rubric generation: normative=${normFile.name}, schema=${schemaFile.name}`);

    // ── Step 1: Extract text from both PDFs ──
    logger.info('Rubric', 'Step 1: Extracting text from PDFs...');
    const [normBuffer, schemaBuffer] = await Promise.all([
      normFile.arrayBuffer().then(b => Buffer.from(b)),
      schemaFile.arrayBuffer().then(b => Buffer.from(b)),
    ]);

    const [normPdf, schemaPdf] = await Promise.all([
      pdfParse(normBuffer),
      pdfParse(schemaBuffer),
    ]);

    if (!normPdf.text?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'No se pudo extraer texto del documento normativo' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!schemaPdf.text?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'No se pudo extraer texto del esquema de evaluación' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Step 2: Extract & store normative ontology ──
    logger.info('Rubric', `Step 2: Extracting normative ontology using provider: ${provider || 'default'}...`);
    const ontology = await comparisonService.extractOntology(normPdf.text, provider);
    logger.info('Rubric', `Ontology extracted: ${ontology.length} items`);

    // Store normative document + ontology items in Neo4j
    const neo4jDriver = (graphBuilder as any).driver;
    if (neo4jDriver) {
      const session = neo4jDriver.session();
      try {
        // Ensure NormativeDocument exists
        await session.run(`
          MERGE (d:Entity {name: $name})
          ON CREATE SET d.createdAt = datetime(), d.type = 'DOCUMENT', d.text = $text
          ON MATCH SET d.text = $text
          SET d:Document:NormativeDocument
        `, { name: normFile.name, text: normPdf.text.substring(0, 500000) });

        // Save OntologyItems
        for (const item of ontology) {
          const uniqueName = `${normFile.name}_${item.id}`;
          await session.run(`
            MATCH (d:Entity {name: $docName})
            WHERE d:NormativeDocument
            MERGE (o:Entity {name: $uniqueName})
            ON CREATE SET
              o.id = $itemId,
              o.requirement = $requirement,
              o.category = $category,
              o.description = $description,
              o.keywords = $keywords,
              o.type = 'CONCEPT',
              o.sourceText = $description,
              o.createdAt = datetime()
            ON MATCH SET
              o.requirement = $requirement,
              o.category = $category,
              o.description = $description,
              o.keywords = $keywords,
              o.sourceText = $description
            SET o:OntologyItem
            MERGE (o)-[:EXTRACTED_FROM]->(d)
          `, {
            docName: normFile.name,
            uniqueName,
            itemId: item.id,
            requirement: item.requirement,
            category: item.category,
            description: item.description,
            keywords: item.keywords || [],
          });
        }
      } finally {
        await session.close();
      }
    }

    // ── Step 3: Extract & store evaluation schema ──
    logger.info('Rubric', `Step 3: Extracting evaluation schema using provider: ${provider || 'default'}...`);
    const schemaAspects = await extractSchemaAspects(schemaPdf.text, config, provider);
    logger.info('Rubric', `Schema aspects extracted: ${schemaAspects.length}`);
    await graphBuilder.saveEvaluationSchema(schemaFile.name, schemaAspects);

    // ── Step 4: Run multi-agent pipeline ──
    logger.info('Rubric', `Step 4: Running multi-agent rubric pipeline with provider: ${provider || 'default'}...`);
    let rubricRaw: any = null;

    for await (const update of runRubricPipeline(normFile.name, schemaFile.name, graphBuilder, provider)) {
      logger.info('Rubric', `[${update.step}] final=${update.isFinal}, content length=${update.content.length}`);

      if (update.step === 'RubricSynthesizerAgent' && update.isFinal) {
        rubricRaw = parseRubricResponse(update.content);
      }
    }

    if (!rubricRaw || !rubricRaw.criteria || rubricRaw.criteria.length === 0) {
      throw new Error('No se pudo generar la rúbrica desde el pipeline multi-agente');
    }

    // Normalize criteria
    const criteria: RubricCriterion[] = rubricRaw.criteria.map((c: any, idx: number) => ({
      id: c.id || `${Math.floor(idx / 3) + 1}.${(idx % 3) + 1}`,
      dimension: c.dimension || 'General',
      criterion: c.criterion || c.name || '',
      description: c.description || '',
      schemaAspectId: c.schemaAspectId || null,
      normativeRefs: c.normativeRefs || [],
      levels: {
        full: c.levels?.full || c.levels?.cumple_totalmente || c.levels?.excellent || '',
        partial: c.levels?.partial || c.levels?.cumple_parcialmente || c.levels?.acceptable || '',
        none: c.levels?.none || c.levels?.no_cumple || c.levels?.insufficient || '',
      },
    }));

    const totalWeight = criteria.length * 2;

    const rubric: RubricData = {
      title: rubricRaw.title || 'Rúbrica Integral para la Auditoría y Revisión de Guías Docentes',
      subtitle: rubricRaw.subtitle || 'EVALUACIÓN DE CUMPLIMIENTO — Sistema Multi-Agente',
      normativeDocument: normFile.name,
      criteria,
      totalWeight,
      generatedAt: new Date().toISOString(),
      nonEvaluableObservations: rubricRaw.nonEvaluableObservations || [],
    };

    logger.info('Rubric', `✅ Multi-agent rubric generated: ${criteria.length} criteria, max score: ${totalWeight} pts`);

    // ── Step 5: Generate PDF ──
    const pdfBuffer = await generateRubricPDF(rubric);
    const pdfBase64 = pdfBuffer.toString('base64');

    // ── Step 6: Persist to Neo4j ──
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

// ── GET ─────────────────────────────────────────────────────────────────────

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

// ── DELETE ───────────────────────────────────────────────────────────────────

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
