import { LlmAgent, SequentialAgent, InMemoryRunner, stringifyContent, isFinalResponse } from '@google/adk';
import { getLlmProvider } from './llm-provider';
import { KnowledgeGraphBuilderImpl } from './knowledge-graph-builder';
import { createLogger } from './logger';
import { PromptLoader } from './prompt-loader';

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
  lang: string = 'es',
  userEmail: string = ''
): AsyncGenerator<AgentStepUpdate, void, unknown> {
  logger.info('MultiAgentService', `Starting correction pipeline: ${programName} using ${normativeName} with provider: ${provider || 'default'} and language: ${lang} for user: ${userEmail}`);

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
      const normDoc = context.state.get<string>('app:normative_doc') || normativeName;
      const progDoc = context.state.get<string>('app:program_doc');
      const email = context.state.get<string>('app:user_email') || '';
      logger.info('NormativeOntologyAgent', `Fetching normative ontology (via program doc entities: ${progDoc}) for user: ${email}`);
      
      let ontology = await graphBuilder.getProgramOntology(progDoc || '', email);
      if (provider === 'groq-fast') {
        ontology = ontology.slice(0, 15);
      }
      
      const sig = PromptLoader.getPrompt('NormativeOntologyAgent');
      return PromptLoader.interpolate(sig.instruction, {
        normativeName: normDoc,
        programName: progDoc || '',
        ontology,
        targetLangName
      });
    }
  });

  const programAgent = new LlmAgent({
    name: 'ProgramOntologyAgent',
    description: 'Reads the syllabus/program ontology from Neo4j.',
    model,
    outputKey: 'app:program_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc');
      const progDoc = context.state.get<string>('app:program_doc') || programName;
      const email = context.state.get<string>('app:user_email') || '';
      logger.info('ProgramOntologyAgent', `Fetching program ontology (via normative doc OntologyItems: ${normDoc}) for user: ${email}`);
      
      let ontology = await graphBuilder.getNormativeOntology(normDoc || '', email);
      if (provider === 'groq-fast') {
        ontology = ontology.slice(0, 15);
      }
      
      const sig = PromptLoader.getPrompt('ProgramOntologyAgent');
      return PromptLoader.interpolate(sig.instruction, {
        normativeName: normDoc || '',
        programName: progDoc,
        ontology,
        targetLangName
      });
    }
  });

  const structureAnalyzerAgent = new LlmAgent({
    name: 'StructureAnalyzerAgent',
    description: 'Analyzes the original PDF structure and returns a JSON representation.',
    model,
    outputKey: 'app:original_structure',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('app:program_doc') || programName;
      const email = context.state.get<string>('app:user_email') || '';
      logger.info('StructureAnalyzerAgent', `Analyzing original structure for: ${progDoc} for user: ${email}`);
      
      let originalText = await graphBuilder.getProgramText(progDoc || '', email);
      if (provider === 'groq-fast' && originalText.length > 8000) {
        originalText = originalText.substring(0, 8000) + '\n... [Texto truncado para el modelo rápido]';
      }
      
      const sig = PromptLoader.getPrompt('StructureAnalyzerAgent');
      return PromptLoader.interpolate(sig.instruction, {
        programName: progDoc,
        originalText
      });
    }
  });

  const complianceAgent = new LlmAgent({
    name: 'ComplianceGapsAgent',
    description: 'Reads compliance gaps (partial/missing items) from Neo4j.',
    model,
    outputKey: 'app:compliance_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc') || normativeName;
      const progDoc = context.state.get<string>('app:program_doc') || programName;
      const email = context.state.get<string>('app:user_email') || '';
      logger.info('ComplianceGapsAgent', `Fetching compliance gaps between ${progDoc} and ${normDoc} for user: ${email}`);
      
      let gaps = await graphBuilder.getComplianceGaps(normDoc || '', progDoc || '', email);
      if (provider === 'groq-fast') {
        gaps = gaps.slice(0, 15);
      }
      
      const sig = PromptLoader.getPrompt('ComplianceGapsAgent');
      return PromptLoader.interpolate(sig.instruction, {
        normativeName: normDoc,
        programName: progDoc,
        gaps,
        targetLangName
      });
    }
  });

  const complianceValidatorAgent = new LlmAgent({
    name: 'ComplianceValidatorAgent',
    description: 'Valida semánticamente y descarta brechas de cumplimiento falsas (declaraciones negativas válidas o no aplicabilidad).',
    model,
    outputKey: 'app:validated_compliance_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc') || normativeName;
      const progDoc = context.state.get<string>('app:program_doc') || programName;
      const email = context.state.get<string>('app:user_email') || '';
      logger.info('ComplianceValidatorAgent', `Validating compliance gaps between ${progDoc} and ${normDoc} for user: ${email}`);

      let originalText = await graphBuilder.getProgramText(progDoc || '', email);
      if (provider === 'groq-fast' && originalText.length > 8000) {
        originalText = originalText.substring(0, 8000) + '\n... [Texto truncado para el modelo rápido]';
      }
      let complianceAnalysis = context.state.get<string>('app:compliance_analysis') || '';
      if (provider === 'groq-fast' && complianceAnalysis.length > 3000) {
        complianceAnalysis = complianceAnalysis.substring(0, 3000) + '\n... [Análisis truncado]';
      }

      const sig = PromptLoader.getPrompt('ComplianceValidatorAgent');
      return PromptLoader.interpolate(sig.instruction, {
        complianceAnalysis,
        originalText,
        targetLangName
      });
    }
  });

  const fixerAgent = new LlmAgent({
    name: 'ProgramFixerAgent',
    description: 'Modifies the original program document to cover all gaps.',
    model,
    outputKey: 'app:corrected_program',
    instruction: async (context) => {
      const progDoc = context.state.get<string>('app:program_doc') || programName;
      const email = context.state.get<string>('app:user_email') || '';
      logger.info('ProgramFixerAgent', `Fetching original text for program doc: ${progDoc} for user: ${email}`);
      
      let originalText = await graphBuilder.getProgramText(progDoc || '', email);
      if (provider === 'groq-fast' && originalText.length > 8000) {
        originalText = originalText.substring(0, 8000) + '\n... [Texto truncado para el modelo rápido]';
      }
      
      // Retrieve intermediate analyses from state
      let normativeAnalysis = context.state.get<string>('app:normative_analysis') || '';
      if (provider === 'groq-fast' && normativeAnalysis.length > 2000) {
        normativeAnalysis = normativeAnalysis.substring(0, 2000) + '\n... [Análisis truncado]';
      }
      let validatedComplianceAnalysis = context.state.get<string>('app:validated_compliance_analysis') || '';
      if (provider === 'groq-fast' && validatedComplianceAnalysis.length > 3000) {
        validatedComplianceAnalysis = validatedComplianceAnalysis.substring(0, 3000) + '\n... [Análisis truncado]';
      }
      let originalStructure = context.state.get<string>('app:original_structure') || '';
      if (provider === 'groq-fast' && originalStructure.length > 2000) {
        originalStructure = originalStructure.substring(0, 2000) + '\n... [Estructura truncada]';
      }
      
      // Parse validated gaps to count them for verification
      let validatedGapsCount = 0;
      let partialCount = 0;
      let missingCount = 0;
      try {
        const cleanedText = validatedComplianceAnalysis.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
        const parsed = JSON.parse(cleanedText);
        const gaps = parsed?.validatedGaps || [];
        validatedGapsCount = gaps.length;
        partialCount = gaps.filter((g: any) => g.status === 'partial').length;
        missingCount = gaps.filter((g: any) => g.status === 'missing').length;
        logger.info('ProgramFixerAgent', `Found ${validatedGapsCount} validated gaps: ${partialCount} partial + ${missingCount} missing`);
      } catch (err) {
        logger.warn('ProgramFixerAgent', 'Could not parse validatedGaps count from compliance analysis', err as Error);
      }
      
      const sig = PromptLoader.getPrompt('ProgramFixerAgent');
      return PromptLoader.interpolate(sig.instruction, {
        normativeAnalysis,
        validatedComplianceAnalysis,
        originalStructure,
        originalText,
        validatedGapsCount,
        targetLangName
      });
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
      'app:program_doc': programName,
      'app:user_email': userEmail
    }
  });

  // 5. Yield updates to caller — with agent trajectory tracking
  const startedAgents = new Set<string>();
  const pipelineStartTime = Date.now();
  logger.info('MultiAgentService', `Pipeline started at ${new Date().toISOString()}`);

  for await (const event of iterator) {
    // Log LLM-level errors that ADK may surface in the event
    const eventAny = event as any;
    if (eventAny.errorCode || eventAny.errorMessage) {
      logger.error('MultiAgentService', `LLM error in agent [${event.author || 'unknown'}]: code=${eventAny.errorCode} msg=${eventAny.errorMessage}`, new Error(String(eventAny.errorMessage || eventAny.errorCode)));
    }

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
          // Log the first 500 chars of the final output for debugging
          const preview = content.length > 500 ? content.substring(0, 500) + '…' : content;
          logger.info('MultiAgentService', `   [${event.author}] output preview: ${preview}`);
        }

        yield {
          step: event.author as any,
          content,
          isFinal
        };
      } else if (isFinalResponse(event)) {
        // Agent finished but produced empty content — this is the bug
        logger.warn('MultiAgentService', `⚠ Agent [${event.author}] finished with EMPTY content. Event keys: ${Object.keys(eventAny).join(', ')}`);
        // Still yield so the caller knows the agent ran
        yield {
          step: event.author as any,
          content: '',
          isFinal: true
        };
      }
    }
  }

  const totalDuration = Date.now() - pipelineStartTime;
  logger.info('MultiAgentService', `Pipeline completed in ${totalDuration}ms. Agents executed: ${Array.from(startedAgents).join(' → ')}`);
}
