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
import { getLlmProvider } from './llm-provider';
import { KnowledgeGraphBuilderImpl } from './knowledge-graph-builder';
import { createLogger } from './logger';
import { PromptLoader } from './prompt-loader';

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
  graphBuilder: KnowledgeGraphBuilderImpl,
  provider?: string,
  lang: string = 'es',
  userEmail: string = ''
): AsyncGenerator<RubricAgentStepUpdate, void, unknown> {
  const languageNames: Record<string, string> = {
    es: 'Español (Castellano)',
    gl: 'Galego (Gallego)',
    en: 'English (Inglés)',
    pt: 'Português (Portugués)',
  };
  const targetLangName = languageNames[lang] || 'Español (Castellano)';

  logger.info(
    'RubricAgentService',
    `Starting rubric pipeline: normative=${normativeName}, schema=${schemaName} with provider=${provider || 'default'} and language=${targetLangName}`
  );

  const model = getLlmProvider(provider);


  // ── Agent 1: Ontology Analyzer ──────────────────────────────────────────
  const ontologyAnalyzer = new LlmAgent({
    name: 'OntologyAnalyzerAgent',
    description: 'Examines the normative ontology from Neo4j and produces a structured analysis of all requirements.',
    model,
    outputKey: 'app:ontology_analysis',
    instruction: async (context) => {
      const normDoc = context.state.get<string>('app:normative_doc') || normativeName;
      logger.info('OntologyAnalyzerAgent', `Fetching ontology for: ${normDoc}`);

      const ontology = await graphBuilder.getNormativeOntology(normDoc, userEmail);

      const sig = PromptLoader.getPrompt('OntologyAnalyzerAgent');
      return PromptLoader.interpolate(sig.instruction, {
        targetLangName,
        ontology
      });
    },
  });

  const schemaAdjuster = new LlmAgent({
    name: 'SchemaOntologyAdjusterAgent',
    description: 'Adjusts the normative ontology using the evaluation schema to determine what aspects to include in the rubric.',
    model,
    outputKey: 'app:adjusted_ontology',
    instruction: async (context) => {
      logger.info('SchemaOntologyAdjusterAgent', 'Fetching evaluation schema and ontology analysis');

      const evaluationSchema = await graphBuilder.getEvaluationSchema(userEmail);
      const normDoc = context.state.get<string>('app:normative_doc') || normativeName;
      const ontology = await graphBuilder.getNormativeOntology(normDoc, userEmail);
      const ontologyAnalysis = context.state.get<string>('app:ontology_analysis') || '';

      const sig = PromptLoader.getPrompt('SchemaOntologyAdjusterAgent');
      return PromptLoader.interpolate(sig.instruction, {
        targetLangName,
        ontologyAnalysis,
        ontology,
        evaluationSchema
      });
    },
  });

  const rubricSynthesizer = new LlmAgent({
    name: 'RubricSynthesizerAgent',
    description: 'Synthesizes the final rubric from the adjusted ontology, covering only schema aspects.',
    model,
    outputKey: 'app:rubric_result',
    instruction: async (context) => {
      const ontologyAnalysis = context.state.get<string>('app:ontology_analysis') || '';
      const adjustedOntology = context.state.get<string>('app:adjusted_ontology') || '';
      const evaluationSchema = await graphBuilder.getEvaluationSchema(userEmail);

      logger.info('RubricSynthesizerAgent', `Synthesizing rubric. Schema has ${evaluationSchema.length} aspects.`);

      const sig = PromptLoader.getPrompt('RubricSynthesizerAgent');
      return PromptLoader.interpolate(sig.instruction, {
        targetLangName,
        ontologyAnalysis,
        adjustedOntology,
        evaluationSchema
      });
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

  // Track agent trajectory
  const startedAgents = new Set<string>();
  const pipelineStartTime = Date.now();
  logger.info('RubricAgentService', `Rubric pipeline started at ${new Date().toISOString()}`);

  for await (const event of iterator) {
    if (event.author && event.author !== 'user' && event.author !== 'RubricPipeline') {
      // Track agent start
      if (!startedAgents.has(event.author)) {
        startedAgents.add(event.author);
        logger.info('RubricAgentService', `▶ Agent [${event.author}] started processing`);
      }

      const content = stringifyContent(event);
      if (content && content.trim()) {
        const final = isFinalResponse(event);

        // Log progress (truncated for readability)
        const truncated = content.length > 200 ? content.substring(0, 200) + '…' : content;
        logger.debug('RubricAgentService', `Agent [${event.author}] progress: ${truncated}`);

        if (final) {
          logger.info('RubricAgentService', `✔ Agent [${event.author}] finished processing (output: ${content.length} chars)`);
        }

        yield {
          step: event.author as RubricAgentStepUpdate['step'],
          content,
          isFinal: final,
        };
      }
    }
  }

  const totalDuration = Date.now() - pipelineStartTime;
  logger.info('RubricAgentService', `Rubric pipeline completed in ${totalDuration}ms. Agents executed: ${Array.from(startedAgents).join(' → ')}`);
}
