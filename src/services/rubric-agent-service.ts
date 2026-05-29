/**
 * Rubric Multi-Agent Service
 *
 * Orchestrates 3 specialised ADK agents via SequentialAgent to generate
 * a holistic rubric from:
 *   1. Normative ontology (extracted and stored in Neo4j)
 *   2. Evaluation schema (aspects to evaluate, extracted from a PDF)
 *
 * The ontology is adjusted using BOTH documents to produce a rubric
 * that covers only the aspects from the evaluation schema, while
 * ensuring concordance with the normative ontology.
 *
 * Agents:
 *   A. OntologyAnalyzerAgent  — examines the extracted normative ontology
 *   B. SchemaOntologyAdjusterAgent — adjusts the ontology using the schema,
 *      identifies non-evaluable normative aspects
 *   C. RubricSynthesizerAgent — produces the final rubric JSON
 */

import { LlmAgent, SequentialAgent, InMemoryRunner, stringifyContent, isFinalResponse } from '@google/adk';
import { GeminiLlm } from './gemini-llm';
import { KnowledgeGraphBuilderImpl } from './knowledge-graph-builder';
import { createLogger } from './logger';

const logger = createLogger();

// ── Types ───────────────────────────────────────────────────────────────────

export interface RubricAgentStepUpdate {
  step:
    | 'OntologyAnalyzerAgent'
    | 'SchemaOntologyAdjusterAgent'
    | 'RubricSynthesizerAgent';
  content: string;
  isFinal: boolean;
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export async function* runRubricPipeline(
  normativeName: string,
  schemaName: string,
  graphBuilder: KnowledgeGraphBuilderImpl
): AsyncGenerator<RubricAgentStepUpdate, void, unknown> {
  logger.info(
    'RubricAgentService',
    `Starting rubric pipeline: normative=${normativeName}, schema=${schemaName}`
  );

  const gemini = new GeminiLlm();

  // ── Agent 1: Ontology Analyzer ──────────────────────────────────────────
  const ontologyAnalyzer = new LlmAgent({
    name: 'OntologyAnalyzerAgent',
    description: 'Examines the normative ontology from Neo4j and produces a structured analysis of all requirements.',
    model: gemini,
    outputKey: 'app:ontology_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc') || normativeName;
      logger.info('OntologyAnalyzerAgent', `Fetching ontology for: ${normDoc}`);

      const ontology = await graphBuilder.getNormativeOntology(normDoc);

      return `Eres un experto en evaluación y acreditación de programas universitarios.

Tu tarea es examinar la siguiente ontología de requisitos normativos extraída de Neo4j y producir un análisis estructurado.

ONTOLOGÍA NORMATIVA (${ontology.length} requisitos):
${JSON.stringify(ontology, null, 2)}

Para CADA requisito, analizá:
1. Qué tipo de requisito es (contenido mínimo, competencia, carga horaria, metodología, evaluación, bibliografía, perfil, infraestructura, etc.)
2. Si es un requisito verificable en un documento de guía docente o si requiere verificación institucional externa
3. Cuál es la importancia/peso del requisito para la acreditación

Devuelve un JSON con esta estructura. No incluyas markdown, solo el JSON puro:
{
  "analysis": [
    {
      "id": "REQ-001",
      "requirement": "texto del requisito",
      "category": "Contenido Mínimo | Competencia | Carga Horaria | etc.",
      "type": "verificable_en_documento | requiere_verificacion_externa",
      "importance": "alta | media | baja",
      "justification": "Breve justificación del análisis"
    }
  ],
  "summary": {
    "total": <count>,
    "verificable_en_documento": <count>,
    "requiere_verificacion_externa": <count>
  }
}`;
    },
  });

  // ── Agent 2: Schema-Ontology Adjuster ───────────────────────────────────
  const schemaAdjuster = new LlmAgent({
    name: 'SchemaOntologyAdjusterAgent',
    description: 'Adjusts the normative ontology using the evaluation schema to determine what aspects to include in the rubric.',
    model: gemini,
    outputKey: 'app:adjusted_ontology',
    instruction: async (context) => {
      logger.info('SchemaOntologyAdjusterAgent', 'Fetching evaluation schema and ontology analysis');

      const evaluationSchema = await graphBuilder.getEvaluationSchema();
      const normDoc = context.state.get<string>('app:normative_doc') || normativeName;
      const ontology = await graphBuilder.getNormativeOntology(normDoc);
      const ontologyAnalysis = context.state.get<string>('app:ontology_analysis') || '';

      return `Eres un experto en diseño curricular, evaluación educativa y acreditación universitaria.

Tenés disponible:
1. El ANÁLISIS DE ONTOLOGÍA del agente anterior (análisis de requisitos normativos)
2. La ONTOLOGÍA NORMATIVA completa extraída de Neo4j
3. El ESQUEMA DE EVALUACIÓN (aspectos que la rúbrica debe cubrir, extraídos de un documento de estructura)

Tu tarea es AJUSTAR la ontología normativa usando ambos documentos para preparar la rúbrica:

A. Cruzar cada aspecto del esquema de evaluación con los requisitos normativos para encontrar la concordancia:
   - Para cada aspecto del esquema, identificar qué requisitos normativos lo sustentan
   - Para cada requisito normativo, identificar si está cubierto por algún aspecto del esquema

B. Clasificar el resultado en:
   - **Aspectos a incluir en la rúbrica**: Aspectos del esquema de evaluación que tienen respaldo normativo (con sus requisitos normativos asociados)
   - **Aspectos normativos sin esquema**: Requisitos normativos que NO aparecen en el esquema de evaluación (estos NO se incluyen en la rúbrica pero se reportan como observaciones)
   - **Aspectos no evaluables**: Requisitos normativos que requieren verificación institucional y no se pueden evaluar desde un documento

C. Para cada aspecto a incluir en la rúbrica, definir:
   - Qué se evalúa concretamente
   - Qué requisitos normativos lo fundamentan
   - Cómo se verifica

ANÁLISIS DE ONTOLOGÍA (del agente anterior):
${ontologyAnalysis}

ONTOLOGÍA NORMATIVA COMPLETA (${ontology.length} requisitos):
${JSON.stringify(ontology, null, 2)}

ESQUEMA DE EVALUACIÓN (${evaluationSchema.length} aspectos — fuente de verdad para la rúbrica):
${JSON.stringify(evaluationSchema, null, 2)}

Devuelve un JSON con esta estructura. No incluyas markdown, solo el JSON puro:
{
  "rubricAspects": [
    {
      "schemaAspectId": "ID del aspecto del esquema",
      "aspect": "nombre del aspecto a evaluar",
      "description": "descripción detallada de qué se evalúa",
      "category": "dimensión/categoría temática",
      "normativeRequirements": ["IDs de requisitos normativos que lo sustentan"],
      "verificationMethod": "cómo se verifica este aspecto en un documento"
    }
  ],
  "normativeWithoutSchema": [
    {
      "id": "REQ-xxx",
      "requirement": "requisito normativo sin esquema",
      "reason": "por qué no está en el esquema o no aplica"
    }
  ],
  "nonEvaluableAspects": [
    {
      "id": "REQ-xxx",
      "requirement": "requisito no evaluable",
      "reason": "por qué requiere verificación externa"
    }
  ]
}`;
    },
  });

  // ── Agent 3: Rubric Synthesizer ─────────────────────────────────────────
  const rubricSynthesizer = new LlmAgent({
    name: 'RubricSynthesizerAgent',
    description: 'Synthesizes the final rubric from the adjusted ontology, covering only schema aspects.',
    model: gemini,
    outputKey: 'app:rubric_result',
    instruction: async (context) => {
      const ontologyAnalysis = context.state.get<string>('app:ontology_analysis') || '';
      const adjustedOntology = context.state.get<string>('app:adjusted_ontology') || '';
      const evaluationSchema = await graphBuilder.getEvaluationSchema();

      logger.info('RubricSynthesizerAgent', `Synthesizing rubric. Schema has ${evaluationSchema.length} aspects.`);

      return `Eres un experto en diseño curricular, evaluación educativa, acreditación universitaria y auditoría de programas.

Tu tarea es generar la RÚBRICA INTEGRAL DE EVALUACIÓN final, usando la ontología ajustada del agente anterior.

REGLAS ESTRICTAS:
1. La rúbrica debe cubrir EXCLUSIVAMENTE los aspectos que el agente anterior definió en "rubricAspects" (que vienen del esquema de evaluación).
2. Cada criterio debe estar fundamentado en los requisitos normativos identificados — referencialos.
3. Los aspectos "normativeWithoutSchema" y "nonEvaluableAspects" NO van en la rúbrica, van como observaciones aparte.
4. Los descriptores de cada nivel deben ser CONCRETOS y ESPECÍFICOS, describiendo exactamente qué evidencia buscar.

NIVELES DE CUMPLIMIENTO (exactamente 3):
- "Cumple Totalmente" (2 puntos) → ÓPTIMO
- "Cumple Parcialmente" (1 punto) → ACEPTABLE CON OBSERVACIÓN
- "No Cumple" (0 puntos) → DEFICIENTE / CRÍTICO

ANÁLISIS DE ONTOLOGÍA (Agente 1):
${ontologyAnalysis}

ONTOLOGÍA AJUSTADA CON ESQUEMA (Agente 2):
${adjustedOntology}

ESQUEMA DE EVALUACIÓN ORIGINAL (${evaluationSchema.length} aspectos — referencia):
${JSON.stringify(evaluationSchema, null, 2)}

Devuelve un JSON con esta estructura exacta. No incluyas markdown, solo el JSON puro:
{
  "title": "Rúbrica Integral para la Auditoría y Revisión de Guías Docentes",
  "subtitle": "EVALUACIÓN DE CUMPLIMIENTO — Generada por Sistema Multi-Agente",
  "criteria": [
    {
      "id": "1.1",
      "dimension": "Nombre de la dimensión temática",
      "criterion": "Nombre del componente evaluado (del esquema de evaluación)",
      "description": "Criterio de calidad institucional detallado — referenciar la normativa",
      "schemaAspectId": "ID del aspecto del esquema que cubre este criterio",
      "normativeRefs": ["IDs de requisitos normativos relacionados"],
      "levels": {
        "full": "ÓPTIMO — Descriptor detallado de cumplimiento total con evidencias específicas",
        "partial": "ACEPTABLE CON OBSERVACIÓN — Descriptor de cumplimiento parcial con deficiencias detectables",
        "none": "DEFICIENTE / CRÍTICO — Descriptor de incumplimiento con falencias críticas"
      }
    }
  ],
  "nonEvaluableObservations": [
    {
      "aspect": "Aspecto normativo no incluido en la rúbrica",
      "reason": "Justificación (no está en el esquema o requiere verificación externa)",
      "recommendation": "Sugerencia de cómo verificarlo fuera de la rúbrica"
    }
  ]
}`;
    },
  });

  // ── Pipeline ────────────────────────────────────────────────────────────
  const pipeline = new SequentialAgent({
    name: 'RubricPipeline',
    subAgents: [ontologyAnalyzer, schemaAdjuster, rubricSynthesizer],
  });

  const runner = new InMemoryRunner({ agent: pipeline });
  const iterator = runner.runEphemeral({
    userId: 'server',
    newMessage: {
      role: 'user',
      parts: [{ text: 'Genera la rúbrica multi-agente ajustando la ontología con el esquema de evaluación' }],
    },
    stateDelta: {
      'app:normative_doc': normativeName,
      'app:schema_doc': schemaName,
    },
  });

  for await (const event of iterator) {
    if (event.author && event.author !== 'user' && event.author !== 'RubricPipeline') {
      const content = stringifyContent(event);
      if (content && content.trim()) {
        const final = isFinalResponse(event);
        yield {
          step: event.author as RubricAgentStepUpdate['step'],
          content,
          isFinal: final,
        };
      }
    }
  }
}
