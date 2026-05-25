import { LlmAgent, SequentialAgent, InMemoryRunner, stringifyContent, isFinalResponse } from '@google/adk';
import { GeminiLlm } from './gemini-llm';
import { KnowledgeGraphBuilderImpl } from './knowledge-graph-builder';
import { createLogger } from './logger';

const logger = createLogger();

export interface AgentStepUpdate {
  step: 'NormativeOntologyAgent' | 'ProgramOntologyAgent' | 'ComplianceGapsAgent' | 'ProgramFixerAgent';
  content: string;
  isFinal: boolean;
}

export async function* runCorrectionPipeline(
  normativeName: string,
  programName: string,
  graphBuilder: KnowledgeGraphBuilderImpl
): AsyncGenerator<AgentStepUpdate, void, unknown> {
  logger.info('MultiAgentService', `Starting correction pipeline: ${programName} using ${normativeName}`);

  // 1. Initialize Gemini LLM
  const gemini = new GeminiLlm();

  // 2. Define specialized agents with dynamic instruction providers
  const normativeAgent = new LlmAgent({
    name: 'NormativeOntologyAgent',
    description: 'Reads the normative document ontology from Neo4j.',
    model: gemini,
    outputKey: 'app:normative_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc');
      logger.info('NormativeOntologyAgent', `Fetching ontology for normative doc: ${normDoc}`);
      
      const ontology = await graphBuilder.getNormativeOntology(normDoc || '');
      return `Eres el agente especialista en ontología normativa. Tu objetivo es leer y estructurar de forma clara los requisitos y estándares normativos provistos desde la base de datos de Neo4j para el documento normativo "${normDoc}".
      
      Aquí está la ontología normativa extraída:
      ${JSON.stringify(ontology, null, 2)}
      
      Por favor, genera un análisis estructurado que resuma los requisitos indispensables que debe cumplir cualquier programa de materia según esta norma.`;
    }
  });

  const programAgent = new LlmAgent({
    name: 'ProgramOntologyAgent',
    description: 'Reads the syllabus/program ontology from Neo4j.',
    model: gemini,
    outputKey: 'app:program_analysis',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('app:program_doc');
      logger.info('ProgramOntologyAgent', `Fetching ontology for program doc: ${progDoc}`);
      
      const ontology = await graphBuilder.getProgramOntology(progDoc || '');
      return `Eres el agente especialista en programas de materias. Tu objetivo es leer y estructurar el contenido actual del programa de materia "${progDoc}" utilizando la información de conceptos y temas cargados en el grafo de Neo4j.
      
      Aquí están los conceptos y contenidos extraídos de la materia:
      ${JSON.stringify(ontology, null, 2)}
      
      Por favor, resume la estructura actual del programa (objetivos, contenidos principales, metodología, etc.) resaltando cómo está organizado originalmente.`;
    }
  });

  const complianceAgent = new LlmAgent({
    name: 'ComplianceGapsAgent',
    description: 'Reads compliance gaps (partial/missing items) from Neo4j.',
    model: gemini,
    outputKey: 'app:compliance_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc');
      const progDoc = context.state.get<string>('app:program_doc');
      logger.info('ComplianceGapsAgent', `Fetching compliance gaps between ${progDoc} and ${normDoc}`);
      
      const gaps = await graphBuilder.getComplianceGaps(normDoc || '', progDoc || '');
      return `Eres el agente especialista en análisis de cumplimiento de planes de estudio universitarios. Tu objetivo es consolidar y detallar las brechas de cumplimiento detectadas (requisitos faltantes o parcialmente cubiertos) en el plan de estudios de la carrera "${progDoc}" con respecto a la norma "${normDoc}".
      
      Aquí están los resultados de cumplimiento parciales o faltantes extraídos de Neo4j:
      ${JSON.stringify(gaps, null, 2)}
      
      Por favor, consolida estas brechas en un informe estructurado.
      
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

  const fixerAgent = new LlmAgent({
    name: 'ProgramFixerAgent',
    description: 'Modifies the original program document to cover all gaps.',
    model: gemini,
    outputKey: 'app:corrected_program',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('app:program_doc');
      logger.info('ProgramFixerAgent', `Fetching original text for program doc: ${progDoc}`);
      
      const originalText = await graphBuilder.getProgramText(progDoc || '');
      
      // Retrieve intermediate analyses from state
      const normativeAnalysis = context.state.get<string>('app:normative_analysis') || '';
      const programAnalysis = context.state.get<string>('app:program_analysis') || '';
      const complianceAnalysis = context.state.get<string>('app:compliance_analysis') || '';
      
      return `Eres el agente corrector de programas y planes de estudio universitarios. Tu tarea final es modificar el documento original del plan de estudios de la carrera para incorporar TODOS los requisitos normativos faltantes o parciales identificados en los análisis previos, asegurando que el plan cumpla al 100% con la normativa.
      
      INFORMACIÓN DEL PIPELINE:
      - Análisis de Requisitos Normativos:
      ${normativeAnalysis}
      
      - Estructura del Programa Original:
      ${programAnalysis}
      
      - Brechas de Cumplimiento y Sugerencias de Corrección:
      ${complianceAnalysis}
      
      INSTRUCCIONES CRÍTICAS DE FORMATO Y ESTRUCTURA:
      1. Debes generar y retornar el programa de materia COMPLETO y corregido.
      2. Mantén EXACTAMENTE la misma estructura de secciones, encabezados, numeraciones y títulos que el programa original. No elimines secciones existentes ni cambies su estilo.
      3. Integra y añade las mejoras directamente dentro de las secciones correspondientes del programa original, redactándolos de forma natural, fluida y profesional.
      4. El resultado debe ser solo el texto corregido del programa de la materia, preservando la fidelidad del documento original pero haciéndolo 100% conforme a la norma. No agregues introducciones, explicaciones, ni notas adicionales fuera del programa.
      5. No resumas el documento original. Debes reescribir todo el texto original sección por sección, pero insertando los contenidos y competencias que faltaban en los lugares adecuados de manera fluida.
      
      DIRECTIVAS ABSTRACTAS DE INTEGRACIÓN PEDAGÓGICA (Crucial):
      - No agregues nuevas asignaturas obligatorias ni alteres la grilla curricular o la carga horaria/créditos de la carrera.
      - Para integrar competencias transversales, éticas o metodológicas (como competencias digitales, ciudadanía digital, privacidad de datos, colaboración virtual, curación y documentación de información digital), realiza una integración **gradual y transversal**.
      - Identifica los espacios integradores de proyectos ya existentes en el plan de estudios (como proyectos introductorios de primer año, asignaturas de sustentabilidad o gestión de mitad de carrera, y proyectos o trabajos integradores finales de graduación) y enriquece sus correspondientes contenidos mínimos, objetivos y metodologías curriculares.
      
      GUÍA DE APLICACIÓN (EJEMPLO REFERENCIAL):
      - Por ejemplo, para integrar el "Marco de Competencias Digitales Docentes de la UBA" en el "Plan de Estudios de Ingeniería en Petróleo" de forma transversal, se enriquece la descripción de sus Proyectos Integradores:
        * Proyecto Inicial (e.g. "Introducción a la Ingeniería en Petróleo"): Se enriquece para incluir colaboración en red virtual, identidad digital y curación/búsqueda de información.
        * Proyecto Intermedio (e.g. "Sustentabilidad de Proyectos de Hidrocarburos"): Se enriquece para incluir privacidad, uso ético y responsable de datos, bienestar digital e impacto social/ético de los algoritmos y automatización.
        * Trabajo Integrador Final (e.g. "TIF I" y "TIF II"): Se enriquece para incluir documentación digital avanzada de proyectos, comunidades de práctica, creación de recursos abiertos y gestión de derechos de autor y propiedad intelectual.
      Aplica esta lógica de forma fluida para fundir las correcciones en el texto original en español técnico universitario adaptado al contexto de la carrera.
      
      TEXTO ORIGINAL DEL PROGRAMA:
      ${originalText}`;
    }
  });

  // 3. Chain agents sequentially
  const pipeline = new SequentialAgent({
    name: 'CorrectionPipeline',
    subAgents: [normativeAgent, programAgent, complianceAgent, fixerAgent]
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

  // 5. Yield updates to caller
  for await (const event of iterator) {
    if (event.author && event.author !== 'user' && event.author !== 'CorrectionPipeline') {
      const content = stringifyContent(event);
      if (content && content.trim()) {
        const isFinal = isFinalResponse(event);
        yield {
          step: event.author as any,
          content,
          isFinal
        };
      }
    }
  }
}
