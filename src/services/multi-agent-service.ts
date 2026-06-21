import { LlmAgent, SequentialAgent, InMemoryRunner, stringifyContent, isFinalResponse } from '@google/adk';
import { getLlmProvider } from './llm-provider';
import { KnowledgeGraphBuilderImpl } from './knowledge-graph-builder';
import { createLogger } from './logger';

const logger = createLogger();

export interface AgentStepUpdate {
  step: 'NormativeOntologyAgent' | 'ProgramOntologyAgent' | 'ComplianceGapsAgent' | 'ComplianceValidatorAgent' | 'StructureAnalyzerAgent' | 'ProgramFixerAgent';
  content: string;
  isFinal: boolean;
}

export async function* runCorrectionPipeline(
  normativeName: string,
  programName: string,
  graphBuilder: KnowledgeGraphBuilderImpl,
  provider?: string,
  lang: string = 'es'
): AsyncGenerator<AgentStepUpdate, void, unknown> {
  logger.info('MultiAgentService', `Starting correction pipeline: ${programName} using ${normativeName} with provider: ${provider || 'default'} and language: ${lang}`);

  const targetLangName = lang === 'gl' ? 'Gallego' : lang === 'pt' ? 'Portugués' : lang === 'en' ? 'Inglés' : 'Español';

  // 1. Initialize LLM
  const model = getLlmProvider(provider);

  // 2. Define specialized agents with dynamic instruction providers
  const normativeAgent = new LlmAgent({
    name: 'NormativeOntologyAgent',
    description: 'Reads the normative document ontology from Neo4j.',
    model,
    outputKey: 'app:normative_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc');
      logger.info('NormativeOntologyAgent', `Fetching ontology for normative doc: ${normDoc}`);
      
      const ontology = await graphBuilder.getNormativeOntology(normDoc || '');
      return `Eres el agente especialista en ontología normativa. Tu objetivo es leer y estructurar de forma clara los requisitos y estándares normativos provistos desde la base de datos de Neo4j para el documento normativo "${normDoc}".
      
      Aquí está la ontología normativa extraída:
      ${JSON.stringify(ontology, null, 2)}
      
      Por favor, genera un análisis estructurado en idioma ${targetLangName} que resuma los requisitos indispensables que debe cumplir cualquier programa de materia según esta norma.`;
    }
  });

  const programAgent = new LlmAgent({
    name: 'ProgramOntologyAgent',
    description: 'Reads the syllabus/program ontology from Neo4j.',
    model,
    outputKey: 'app:program_analysis',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('app:program_doc');
      logger.info('ProgramOntologyAgent', `Fetching ontology for program doc: ${progDoc}`);
      
      const ontology = await graphBuilder.getProgramOntology(progDoc || '');
      return `Eres el agente especialista en programas de materias. Tu objetivo es leer y estructurar el contenido actual del programa de materia "${progDoc}" utilizando la información de conceptos y temas cargados en el grafo de Neo4j.
      
      Aquí están los conceptos y contenidos extraídos de la materia:
      ${JSON.stringify(ontology, null, 2)}
      
      Por favor, resume la estructura actual del programa (objetivos, contenidos principales, metodología, etc.) en idioma ${targetLangName} resaltando cómo está organizado originalmente.`;
    }
  });

  const structureAnalyzerAgent = new LlmAgent({
    name: 'StructureAnalyzerAgent',
    description: 'Analyzes the original PDF structure and returns a JSON representation.',
    model,
    outputKey: 'app:original_structure',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('app:program_doc');
      logger.info('StructureAnalyzerAgent', `Analyzing original structure for: ${progDoc}`);
      
      const originalText = await graphBuilder.getProgramText(progDoc || '');
      return `Eres el agente especialista en análisis de estructura de documentos. Tu objetivo es leer el texto del programa de materia "${progDoc}" y extraer su estructura (secciones, subsecciones, tablas, y estilo de viñetas).
      
      Texto del programa:
      ${originalText}
      
      Devuelve ÚNICAMENTE un JSON válido que describa esta estructura (ej. un array de objetos detallando jerarquía de títulos y elementos).`;
    }
  });

  const complianceAgent = new LlmAgent({
    name: 'ComplianceGapsAgent',
    description: 'Reads compliance gaps (partial/missing items) from Neo4j.',
    model,
    outputKey: 'app:compliance_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc');
      const progDoc = context.state.get<string>('app:program_doc');
      logger.info('ComplianceGapsAgent', `Fetching compliance gaps between ${progDoc} and ${normDoc}`);
      
      const gaps = await graphBuilder.getComplianceGaps(normDoc || '', progDoc || '');
      return `Eres el agente especialista en análisis de cumplimiento de planes de estudio universitarios. Tu objetivo es consolidar y detallar las brechas de cumplimiento detectadas (requisitos faltantes o parcialmente cubiertos) en el plan de estudios de la carrera "${progDoc}" con respecto a la norma "${normDoc}".
      
      Aquí están los resultados de cumplimiento parciales o faltantes extraídos de Neo4j:
      ${JSON.stringify(gaps, null, 2)}
      
      Por favor, consolida estas brechas en un informe estructurado escrito en idioma ${targetLangName}.
      
      DIRECTIVAS DE ANÁLISIS PEDAGÓGICO (Abstractas):
      1. Evita proponer la creación de nuevas asignaturas para cubrir competencias transversales o metodológicas (como competencias digitales, ética, comunicación o colaboración). En su lugar, promueve la integración gradual y transversal en asignaturas existentes a lo largo del trayecto formativo.
      2. Recomienda explícitamente enriquecer los espacios de integración curricular (proyectos iniciales, intermedios y finales/tesis) para incorporar allí la práctica, documentación y evaluación de estas competencias de forma contextualizada.
      
      GUÍA DE APLICACIÓN (EJEMPLO REFERENCIAL):
      - Si se comparara el "Plan de Estudios de Ingeniería en Petróleo" con el "Marco de Competencias Digitales Docentes de la UBA":
        * En lugar de aislar lo digital en materias como Ciencia de Datos o IA, se deberían enriquecer transversalmente los Proyectos Integradores (Inicial, Intermedio y TIF).
        * Proyecto Inicial (e.g., Introducción a la Ingeniería): Incorporar herramientas de colaboración digital en red, identidad digital y curación/búsqueda de fuentes de información.
        * Proyecto Intermedio (e.g., Sustentabilidad): Incorporar el uso ético de datos, la privacidad, bienestar digital y el impacto social de algoritmos y automatización.
        * Trabajo Integrador Final (TIF): Incorporar la documentación digital avanzada, colaboración virtual, la participación en comunidades de práctica profesional, creación e intercambio de recursos abiertos y derechos de autor/propiedad intelectual.
      Use este enfoque integrador y transversal para redactar las sugerencias de mejora del plan actual.`;
    }
  });

  const complianceValidatorAgent = new LlmAgent({
    name: 'ComplianceValidatorAgent',
    description: 'Valida semánticamente y descarta brechas de cumplimiento falsas (declaraciones negativas válidas o no aplicabilidad).',
    model,
    outputKey: 'app:validated_compliance_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc');
      const progDoc = context.state.get<string>('app:program_doc');
      logger.info('ComplianceValidatorAgent', `Validating compliance gaps between ${progDoc} and ${normDoc}`);

      const originalText = await graphBuilder.getProgramText(progDoc || '');
      const complianceAnalysis = context.state.get<string>('app:compliance_analysis') || '';

      return `Eres el Agente Validador de Cumplimiento Semántico. Tu rol es analizar críticamente las brechas de cumplimiento detectadas y el texto original del programa para filtrar falsos positivos o recomendaciones redundantes e innecesarias.

INFORMACIÓN DEL PIPELINE:
- Brechas de Cumplimiento Detectadas:
${complianceAnalysis}

- Texto Original del Programa:
${originalText}

DIRECTIVAS DE EVALUACIÓN SEMÁNTICA Y HOLÍSTICA:
1. Evalúa cada brecha reportada comparándola con el texto original del programa.
2. Identifica "Declaraciones Negativas Válidas": Si una brecha reclama que falta regular o detallar un aspecto (por ejemplo, procedimientos de dispensa académica, exenciones de asistencia, requerimiento de software pago, laboratorios específicos, etc.) y en el programa el docente indica explícitamente que NO aplica, que NO se concede, o que NINGUNA actividad está sujeta a ello (ej: "no se concede dispensa académica en ningún caso", "todas las actividades son obligatorias", "no hay software requerido"), esto constituye una regulación completa y válida para la materia. Debes declarar esta brecha como un FALSO POSITIVO y removerla/descartarla para que no se intente generar una corrección innecesaria.
3. Identifica "No Aplicabilidad por Naturaleza": Si un requisito normativo de infraestructura o equipamiento no aplica al tipo de asignatura (por ejemplo, laboratorios físicos para una materia puramente teórica), clasifica la brecha como FALSO POSITIVO y remuévela.
4. Conserva únicamente las BRECHAS REALES donde efectivamente falte información que la norma exige obligatoriamente y que no haya sido abordada en absoluto en el programa.
5. SÉ PRUDENTE AL DESCARTAR: No elimines brechas si no hay una justificación explícita en el programa original. Si tienes dudas sobre si el programa cubre el requisito, mantén la brecha como real para asegurar cobertura completa.

Devuelve un JSON que contenga la lista final depurada de brechas reales de cumplimiento. Todos los campos de texto descriptivos (ej: description, evidence, suggestion, reason) deben estar escritos obligatoriamente en idioma ${targetLangName}. No incluyas markdown, solo el JSON puro con esta estructura:
{
  "validatedGaps": [
    {
      "id": "ID del requisito",
      "category": "Categoría",
      "requirement": "Texto del requisito",
      "description": "Descripción",
      "status": "partial | missing",
      "evidence": "Evidencia hallada en el programa",
      "suggestion": "Sugerencia pedagógica de adecuación"
    }
  ],
  "excludedGaps": [
    {
      "id": "ID del requisito",
      "requirement": "Texto del requisito",
      "reason": "Justificación detallada de por qué se considera falso positivo o no aplica"
    }
  ]
}`;
    }
  });

  const fixerAgent = new LlmAgent({
    name: 'ProgramFixerAgent',
    description: 'Modifies the original program document to cover all gaps.',
    model,
    outputKey: 'app:corrected_program',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('app:program_doc');
      logger.info('ProgramFixerAgent', `Fetching original text for program doc: ${progDoc}`);
      
      const originalText = await graphBuilder.getProgramText(progDoc || '');
      
      // Retrieve intermediate analyses from state
      const normativeAnalysis = context.state.get<string>('app:normative_analysis') || '';
      const validatedComplianceAnalysis = context.state.get<string>('app:validated_compliance_analysis') || '';
      const originalStructure = context.state.get<string>('app:original_structure') || '';
      
      // Parse validated gaps to count them for verification
      let validatedGapsCount = 0;
      let partialCount = 0;
      let missingCount = 0;
      try {
        const parsed = JSON.parse(validatedComplianceAnalysis);
        const gaps = parsed?.validatedGaps || [];
        validatedGapsCount = gaps.length;
        partialCount = gaps.filter((g: any) => g.status === 'partial').length;
        missingCount = gaps.filter((g: any) => g.status === 'missing').length;
        logger.info('ProgramFixerAgent', `Found ${validatedGapsCount} validated gaps: ${partialCount} partial + ${missingCount} missing`);
      } catch (err) {
        logger.warn('ProgramFixerAgent', 'Could not parse validatedGaps count from compliance analysis', err as Error);
      }
      
      return `Eres el agente especialista en adecuación curricular de planes de estudio universitarios. Tu tarea es generar un listado ESTRUCTURADO de correcciones que deben aplicarse al programa de estudios original para cubrir únicamente las brechas normativas REALES y VALIDADAS.

      IMPORTANTE: NO reescribas el documento completo. El documento original se preservará tal cual está. Solo necesitás listar las correcciones puntuales.
      
      INFORMACIÓN DEL PIPELINE:
      - Análisis de Requisitos Normativos:
      ${normativeAnalysis}
      
      - Brechas de Cumplimiento Validadas (¡SOLO debes corregir estas!):
      ${validatedComplianceAnalysis}
      
      - Estructura Original Detectada (JSON):
      ${originalStructure}
      
      TEXTO ORIGINAL DEL PROGRAMA (referencia):
      ${originalText}
      
      ⚠️ OBLIGACIÓN CRÍTICA DE COBERTURA EXHAUSTIVA DE BRECHAS:
      - Las "Brechas de Cumplimiento Validadas" contienen un array "validatedGaps" con ${validatedGapsCount} no conformidades detectadas.
      - Debes revisar CADA UNA de las ${validatedGapsCount} brechas en el array "validatedGaps".
      - IMPORTANTE: Las brechas pueden tener status "missing" (faltante completo) o "partial" (parcialmente cubierto). Ambos tipos REQUIEREN corrección y DEBEN incluirse en tu respuesta.
      - Para CADA brecha validada (tanto "partial" como "missing"), debes generar EXACTAMENTE UNA corrección independiente en el array "corrections".
      - Las brechas "partial" son tan importantes como las "missing" - indican que el programa menciona el tema pero no lo desarrolla suficientemente según la normativa.
      - NO agrupes múltiples brechas en una sola corrección genérica.
      - NO resumas ni omitas ninguna brecha, especialmente las "partial".
      - El array "corrections" de tu respuesta DEBE contener exactamente ${validatedGapsCount} elementos (uno por brecha validada).
      - Si hay ${validatedGapsCount} brechas validadas, debe haber exactamente ${validatedGapsCount} correcciones en el array resultante.
      - Esto es OBLIGATORIO para asegurar que todas las no conformidades aparezcan de forma explícita y separada en el anexo de correcciones del documento PDF final.
      
      INSTRUCCIONES DE IDIOMA Y FORMATO DE SALIDA:
      - Todos los campos de texto descriptivos y propuestas de adecuación ("justification", "correctedText") deben estar redactados obligatoriamente en idioma ${targetLangName}.
      - Devolvé ÚNICAMENTE un JSON válido con la siguiente estructura. No incluyas markdown, solo el JSON puro:

      {"corrections": [
        {
          "section": "Nombre exacto de la sección del documento original donde aplicar la corrección (ej: 'Objetivos', 'Contenidos Mínimos', 'Metodología de Enseñanza')",
          "action": "agregar | modificar | enriquecer",
          "justification": "Explicación breve de por qué es necesaria esta corrección según la normativa, citando el ID de la brecha validada y su status (partial o missing)",
          "correctedText": "El texto completo que debe incorporarse o reemplazar al existente en esa sección",
          "priority": "alta | media | baja",
          "gapId": "ID de la brecha validada que esta corrección resuelve (para trazabilidad)",
          "status": "partial | missing (copiado del validatedGap correspondiente)"
        }
      ]}
      
      EJEMPLO DE CÓMO MANEJAR BRECHAS PARCIALES:
      Si una brecha tiene status "partial" con evidence: "Se menciona metodología activa pero no se detallan actividades específicas", 
      tu corrección debe usar action: "enriquecer" y proporcionar el texto que COMPLETA lo que ya existe.
      
      Si una brecha tiene status "missing", usa action: "agregar" y proporciona el texto completo que debe agregarse.
      
      DIRECTIVAS DE INTEGRACIÓN PEDAGÓGICA:
      - Integrá transversalmente las competencias faltantes en asignaturas y proyectos existentes.
      - Evitá proponer nuevas asignaturas obligatorias.
      - Enriquecé los espacios de integración curricular existentes (proyectos integradores, trabajos finales).
      - Cada corrección debe ser autónoma y aplicable directamente sobre el documento original.
      - Si no hay brechas reales en validatedComplianceAnalysis (es decir, validatedGaps está vacío), devuelve un array "corrections" vacío: {"corrections": []}. NO inventes correcciones si no hay brechas reales validadas.
      
      ⚠️ VERIFICACIÓN FINAL ANTES DE RESPONDER:
      - Cuenta cuántos elementos hay en tu array "corrections" antes de devolver la respuesta.
      - Verifica que el número coincida exactamente con el número de elementos en "validatedGaps" (${validatedGapsCount}).
      - Si no coinciden, revisa qué brechas olvidaste y agrégalas.
      
      Generá únicamente el JSON de correcciones.`;
    }
  });

  // 3. Chain agents sequentially
  const pipeline = new SequentialAgent({
    name: 'CorrectionPipeline',
    subAgents: [normativeAgent, programAgent, structureAnalyzerAgent, complianceAgent, complianceValidatorAgent, fixerAgent]
  });

  // 4. Run pipeline
  const runner = new InMemoryRunner({ agent: pipeline });
  const iterator = runner.runEphemeral({
    userId: 'server',
    newMessage: { role: 'user', parts: [{ text: 'Inicia la corrección del programa de materia' }] },
    stateDelta: {
      'app:normative_doc': normativeName,
      'app:program_doc': programName
    }
  });

  // 5. Yield updates to caller — with agent trajectory tracking
  const startedAgents = new Set<string>();
  const pipelineStartTime = Date.now();
  logger.info('MultiAgentService', `Pipeline started at ${new Date().toISOString()}`);

  for await (const event of iterator) {
    if (event.author && event.author !== 'user' && event.author !== 'CorrectionPipeline') {
      // Track agent start
      if (!startedAgents.has(event.author)) {
        startedAgents.add(event.author);
        logger.info('MultiAgentService', `▶ Agent [${event.author}] started processing`);
      }

      const content = stringifyContent(event);
      if (content && content.trim()) {
        const isFinal = isFinalResponse(event);

        // Log progress (truncated for readability)
        const truncated = content.length > 200 ? content.substring(0, 200) + '…' : content;
        logger.debug('MultiAgentService', `Agent [${event.author}] progress: ${truncated}`);

        if (isFinal) {
          logger.info('MultiAgentService', `✔ Agent [${event.author}] finished processing (output: ${content.length} chars)`);
        }

        yield {
          step: event.author as any,
          content,
          isFinal
        };
      }
    }
  }

  const totalDuration = Date.now() - pipelineStartTime;
  logger.info('MultiAgentService', `Pipeline completed in ${totalDuration}ms. Agents executed: ${Array.from(startedAgents).join(' → ')}`);
}
