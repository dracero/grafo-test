import { LlmAgent, SequentialAgent, InMemoryRunner, stringifyContent, isFinalResponse } from '@google/adk';
import { GroqLlm } from './groq-llm';
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

  // 1. Initialize Groq LLM
  const groq = new GroqLlm();

  // 2. Define specialized agents with dynamic instruction providers
  const normativeAgent = new LlmAgent({
    name: 'NormativeOntologyAgent',
    description: 'Reads the normative document ontology from Neo4j.',
    model: groq,
    outputKey: 'temp:normative_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('temp:normative_doc');
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
    model: groq,
    outputKey: 'temp:program_analysis',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('temp:program_doc');
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
    model: groq,
    outputKey: 'temp:compliance_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('temp:normative_doc');
      const progDoc = context.state.get<string>('temp:program_doc');
      logger.info('ComplianceGapsAgent', `Fetching compliance gaps between ${progDoc} and ${normDoc}`);
      
      const gaps = await graphBuilder.getComplianceGaps(normDoc || '', progDoc || '');
      return `Eres el agente especialista en análisis de cumplimiento. Tu objetivo es detallar las brechas de cumplimiento detectadas (requisitos faltantes o parcialmente cubiertos) en la materia "${progDoc}" con respecto a la norma "${normDoc}".
      
      Aquí están los resultados de cumplimiento parciales o faltantes extraídos de Neo4j:
      ${JSON.stringify(gaps, null, 2)}
      
      Por favor, consolida estas brechas en un informe claro, indicando exactamente qué falta y cuáles son las sugerencias pedagógicas de corrección para que el agente corrector sepa exactamente qué integrar.`;
    }
  });

  const fixerAgent = new LlmAgent({
    name: 'ProgramFixerAgent',
    description: 'Modifies the original program document to cover all gaps.',
    model: groq,
    outputKey: 'temp:corrected_program',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('temp:program_doc');
      logger.info('ProgramFixerAgent', `Fetching original text for program doc: ${progDoc}`);
      
      const originalText = await graphBuilder.getProgramText(progDoc || '');
      
      // Retrieve intermediate analyses from state
      const normativeAnalysis = context.state.get<string>('temp:normative_analysis') || '';
      const programAnalysis = context.state.get<string>('temp:program_analysis') || '';
      const complianceAnalysis = context.state.get<string>('temp:compliance_analysis') || '';
      
      return `Eres el agente corrector de programas de materias. Tu tarea final es modificar el documento original del programa de materia para incorporar TODOS los requisitos normativos faltantes o parciales identificados en los análisis previos, asegurando que cumpla al 100% con la normativa.
      
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
      3. Integra y añade las mejoras (contenidos mínimos, bibliografías, o metodologías faltantes) directamente dentro de las secciones correspondientes del programa original, redactándolos de forma natural, fluida y profesional.
      4. El resultado debe ser solo el texto corregido del programa de la materia, preservando la fidelidad del documento original pero haciéndolo 100% conforme a la norma. No agregues introducciones, explicaciones, ni notas adicionales fuera del programa.
      
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
      'temp:normative_doc': normativeName,
      'temp:program_doc': programName
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
