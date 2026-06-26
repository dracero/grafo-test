import dotenv from 'dotenv';
import path from 'path';
import { connectToMongoDB } from '../src/lib/mongodb';
import { getLlmProvider } from '../src/services/llm-provider';
import { PromptLoader } from '../src/services/prompt-loader';
import { GeminiLlm } from '../src/services/gemini-llm';

// Load environment variables from .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const AVAILABLE_AGENTS = [
  'ComplianceGapsAgent',
  'ComplianceValidatorAgent',
  'NormativeOntologyAgent',
  'OntologyAnalyzerAgent',
  'ProgramFixerAgent',
  'ProgramOntologyAgent',
  'RubricSynthesizerAgent',
  'SchemaOntologyAdjusterAgent',
  'StructureAnalyzerAgent'
];

interface CustomDataInst {
  inputs: Record<string, any>;
  expectedOutput: string;
}

interface CustomTrajectory {
  inputs: Record<string, any>;
  output: string;
  expected: string;
  score: number;
  reason: string;
}

// Function to call LLM Agent
async function runAgent(
  provider: string,
  agentName: string,
  inputs: Record<string, any>,
  instructionTemplate: string
): Promise<string> {
  const model = getLlmProvider(provider);
  const interpolatedPrompt = PromptLoader.interpolate(instructionTemplate, inputs);

  const request = {
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Procesa las siguientes entradas de acuerdo con tus directivas.' }]
      }
    ],
    config: {
      systemInstruction: interpolatedPrompt,
      temperature: 0.1
    }
  };

  let output = '';
  for await (const chunk of model.generateContentAsync(request)) {
    if (chunk.errorMessage) {
      throw new Error(`LLM Error: ${chunk.errorMessage}`);
    }
    if (chunk.content?.parts) {
      for (const part of chunk.content.parts) {
        if (typeof part === 'string') {
          output += part;
        } else if (part.text) {
          output += part.text;
        }
      }
    }
  }
  return output.trim();
}

// Function to grade outputs using LLM-as-a-judge
async function runJudge(
  provider: string,
  inputs: Record<string, any>,
  expectedOutput: string,
  generatedOutput: string
): Promise<{ score: number; reason: string }> {
  const judgeModel = getLlmProvider(provider);

  const judgePrompt = `Eres un evaluador experto de outputs de IA. Tu tarea es calificar la calidad de una respuesta generada en comparación con la respuesta esperada (Gold Standard), teniendo en cuenta el contexto de las entradas.

ENTRADAS DEL AGENTE:
${JSON.stringify(inputs, null, 2)}

RESPUESTA ESPERADA (GOLD STANDARD):
${expectedOutput}

RESPUESTA GENERADA A EVALUAR:
${generatedOutput}

Instrucciones de calificación:
1. Si la respuesta esperada es un JSON estructurado, evalúa si la respuesta generada es un JSON válido, si contiene la misma información semántica y cobertura de requisitos clave, y si sigue la estructura esperada de campos.
2. Si la respuesta esperada es texto general o markdown, evalúa la cobertura semántica, la precisión y si cumple con todas las directivas especificadas.
3. Asigna un puntaje decimal entre 0.0 y 1.0, donde:
   - 1.0 es perfecta coincidencia semántica o superior (cubre todo lo esperado correctamente).
   - 0.8 es muy buena, con diferencias menores en la redacción o detalles menores de formato.
   - 0.5 cubre parte de lo esperado pero omite puntos importantes.
   - 0.2 es muy pobre, con respuestas irrelevantes o erróneas.
   - 0.0 es totalmente incorrecta, vacía o inválida.

Devuelve estrictamente un objeto JSON con este formato:
{
  "score": <número entre 0.0 y 1.0>,
  "reason": "<breve justificación en español>"
}

No incluyas delimitadores markdown como \`\`\`json ni texto adicional, solo el JSON crudo.`;

  const request = {
    contents: [
      {
        role: 'user',
        parts: [{ text: judgePrompt }]
      }
    ],
    config: {
      temperature: 0.1
    }
  };

  let output = '';
  for await (const chunk of judgeModel.generateContentAsync(request)) {
    if (chunk.errorMessage) {
      throw new Error(`Judge LLM Error: ${chunk.errorMessage}`);
    }
    if (chunk.content?.parts) {
      for (const part of chunk.content.parts) {
        if (typeof part === 'string') {
          output += part;
        } else if (part.text) {
          output += part.text;
        }
      }
    }
  }

  try {
    const cleaned = output.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    const score = typeof parsed.score === 'number' ? parsed.score : 0.0;
    const reason = String(parsed.reason || 'No reason provided');
    return { score, reason };
  } catch (err: any) {
    const scoreMatch = output.match(/"score"\s*:\s*([\d.]+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5;
    return {
      score: isNaN(score) ? 0.0 : score,
      reason: `Error al parsear respuesta JSON del juez: ${err.message}. Salida cruda: ${output}`
    };
  }
}

// Seed dataset if empty to enable testing immediately
async function seedDatasetIfNeeded(db: any, agentName: string) {
  const collection = db.collection('OptimizationDataset');
  const count = await collection.countDocuments({ agentName });
  if (count > 0) return;

  console.log(`ℹ No se encontraron ejemplos de curación en MongoDB para "${agentName}". Sembrando ejemplos de prueba...`);

  const now = new Date();
  let seedExamples: any[] = [];

  if (agentName === 'ComplianceValidatorAgent') {
    seedExamples = [
      {
        agentName,
        inputs: {
          complianceAnalysis: "Requisito: INFRA-01 - Se requiere laboratorio físico de química con reactivos y extractores.\nEstado detectado: Faltante en el programa.",
          originalText: "La asignatura 'Introducción a la Química Orgánica' es de carácter teórico-virtual. No se requiere laboratorio físico ya que las prácticas se simulan mediante software interactivo (ChemLab).",
          targetLangName: "Español"
        },
        expectedOutput: JSON.stringify({
          validatedGaps: [],
          excludedGaps: [
            {
              id: "INFRA-01",
              requirement: "Laboratorio físico de química con reactivos y extractores",
              reason: "El programa especifica explícitamente que la materia es puramente teórica-virtual y que las prácticas se simulan con software ChemLab, por lo que el requerimiento de laboratorio físico no aplica en este caso (declaración negativa válida)."
            }
          ]
        }, null, 2),
        sourceRunId: "mock-run-opt-1",
        curatedAt: now,
        updatedAt: now
      },
      {
        agentName,
        inputs: {
          complianceAnalysis: "Requisito: COMP-02 - Explicitar competencias digitales docentes.\nEstado detectado: Faltante.",
          originalText: "Competencias: Capacidad de análisis, trabajo en equipo, resolución de problemas prácticos utilizando planillas de cálculo Excel.",
          targetLangName: "Español"
        },
        expectedOutput: JSON.stringify({
          validatedGaps: [
            {
              id: "COMP-02",
              category: "Competencias",
              requirement: "Explicitar competencias digitales docentes",
              description: "Falta especificar de forma directa las competencias digitales en el programa.",
              status: "missing",
              evidence: "Solo se menciona el uso de planillas de cálculo Excel, pero no se detallan las competencias digitales requeridas de manera formal.",
              suggestion: "Incorporar un apartado que enumere explícitamente las competencias digitales y de comunicación digital docente asociadas al dictado de la materia."
            }
          ],
          excludedGaps: []
        }, null, 2),
        sourceRunId: "mock-run-opt-2",
        curatedAt: now,
        updatedAt: now
      }
    ];
  } else if (agentName === 'ProgramFixerAgent') {
    seedExamples = [
      {
        agentName,
        inputs: {
          normativeAnalysis: "La norma exige explicitar la bibliografía obligatoria con fecha posterior a 2015.",
          validatedComplianceAnalysis: JSON.stringify({
            validatedGaps: [
              {
                id: "BIB-03",
                category: "Bibliografía",
                requirement: "Bibliografía posterior a 2015",
                description: "Falta bibliografía actualizada",
                status: "missing",
                evidence: "Toda la bibliografía es anterior a 2010.",
                suggestion: "Agregar bibliografía recomendada posterior a 2015."
              }
            ]
          }, null, 2),
          originalStructure: "1. Objetivos\n2. Contenidos\n3. Bibliografía",
          originalText: "Programa de Física I.\nBibliografía: Sears-Zemansky, Física Universitaria, 2009.",
          validatedGapsCount: 1,
          targetLangName: "Español"
        },
        expectedOutput: `CORRECCIONES PROPUESTAS:

SECCIÓN 1: RESUMEN DE REQUISITOS FALTANTES
- BIB-03: Bibliografía posterior a 2015 (Faltante). La bibliografía del programa es obsoleta (anterior a 2010).

SECCIÓN 2: PROPUESTA DE CORRECCIÓN PARA REQUISITOS PARCIALES O FALTANTES
Modificar la sección de Bibliografía del programa original agregando textos actualizados:

\`\`\`diff
 Bibliografía:
 Sears-Zemansky, Física Universitaria, 2009.
+ bibliografía sugerida actualizada:
+ - Tipler, P. A., & Mosca, G. (2016). Física para la ciencia y la tecnología (6ª ed.). Reverté.
+ - Serway, R. A., & Jewett, J. W. (2018). Física para ciencias e ingeniería (10ª ed.). Cengage Learning.
\`\`\``,
        sourceRunId: "mock-run-opt-3",
        curatedAt: now,
        updatedAt: now
      }
    ];
  } else {
    seedExamples = [
      {
        agentName,
        inputs: {
          inputData: `Ejemplo de datos de entrada para ${agentName}.`,
          targetLangName: "Español"
        },
        expectedOutput: `Respuesta de referencia esperada para ${agentName} acorde a la entrada de ejemplo.`,
        sourceRunId: "mock-run-opt-generic",
        curatedAt: now,
        updatedAt: now
      }
    ];
  }

  await collection.insertMany(seedExamples);
  console.log(`✔ Sembrados ${seedExamples.length} ejemplos exitosamente.`);
}

async function main() {
  const args = process.argv.slice(2);
  let agentName = '';
  let provider = 'gemini';
  let judgeProvider = 'gemini';
  let reflectionModel = 'gemini-2.5-flash';
  let maxCalls = 6;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) {
      agentName = args[i + 1];
      i++;
    } else if (args[i] === '--provider' && args[i + 1]) {
      provider = args[i + 1];
      i++;
    } else if (args[i] === '--judge' && args[i + 1]) {
      judgeProvider = args[i + 1];
      i++;
    } else if (args[i] === '--reflection-model' && args[i + 1]) {
      reflectionModel = args[i + 1];
      i++;
    } else if (args[i] === '--max-calls' && args[i + 1]) {
      maxCalls = parseInt(args[i + 1], 10);
      i++;
    }
  }

  if (!agentName) {
    console.error(`❌ Error: Se debe especificar el parámetro --agent.`);
    console.log(`Agentes disponibles:`);
    AVAILABLE_AGENTS.forEach(a => console.log(`  - ${a}`));
    console.log(`Ejemplo: npx tsx scripts/optimize.ts --agent ComplianceValidatorAgent`);
    process.exit(1);
  }

  if (!AVAILABLE_AGENTS.includes(agentName)) {
    console.error(`❌ Error: Agente "${agentName}" no reconocido.`);
    console.log(`Elige uno de: ${AVAILABLE_AGENTS.join(', ')}`);
    process.exit(1);
  }

  console.log(`⚙ Iniciando Optimización GEPA para el agente: ${agentName}`);
  console.log(`🔌 Provider Tarea: ${provider} | Juez: ${judgeProvider}`);
  console.log(`🎯 Presupuesto de llamadas métricas (max-calls): ${maxCalls}`);

  // Dynamic import of gepa-ts to force ESM resolution of the package exports
  const { optimize, BaseAdapter } = await import('gepa-ts');

  // Custom GEPA Adapter for LLM Agents defined inside main to capture BaseAdapter
  class AgentGEPAAdapter extends BaseAdapter<CustomDataInst, CustomTrajectory, string> {
    private aName: string;
    private prov: string;
    private jProv: string;

    constructor(name: string, p: string, jp: string) {
      super();
      this.aName = name;
      this.prov = p;
      this.jProv = jp;
    }

    async evaluate(
      batch: CustomDataInst[],
      candidate: ComponentMap,
      captureTraces: boolean = false
    ): Promise<EvaluationBatch<CustomTrajectory, string>> {
      const outputs: string[] = [];
      const scores: number[] = [];
      const trajectories: CustomTrajectory[] | null = captureTraces ? [] : null;

      const instructionTemplate = candidate[this.aName] || '';

      for (const example of batch) {
        try {
          const output = await runAgent(this.prov, this.aName, example.inputs, instructionTemplate);
          outputs.push(output);

          const { score, reason } = await runJudge(this.jProv, example.inputs, example.expectedOutput, output);
          scores.push(score);

          if (trajectories) {
            trajectories.push({
              inputs: example.inputs,
              output,
              expected: example.expectedOutput,
              score,
              reason
            });
          }
        } catch (err: any) {
          console.error(`❌ Error en evaluación de ejemplo:`, err.message);
          outputs.push('');
          scores.push(0.0);
          if (trajectories) {
            trajectories.push({
              inputs: example.inputs,
              output: `Error: ${err.message}`,
              expected: example.expectedOutput,
              score: 0.0,
              reason: `Error: ${err.message}`
            });
          }
        }
      }

      return { outputs, scores, trajectories };
    }

    async makeReflectiveDataset(
      candidate: ComponentMap,
      evalBatch: EvaluationBatch<CustomTrajectory, string>,
      componentsToUpdate: string[]
    ): Promise<ReflectiveDataset> {
      const dataset: ReflectiveDataset = {};

      if (!evalBatch.trajectories) {
        return dataset;
      }

      for (const componentName of componentsToUpdate) {
        if (componentName === this.aName) {
          dataset[componentName] = evalBatch.trajectories.map(traj => ({
            'Inputs': traj.inputs,
            'Generated Output': traj.output,
            'Expected Output': traj.expected,
            'Evaluation Score': traj.score,
            'Feedback/Reason': traj.reason
          }));
        }
      }

      return dataset;
    }
  }

  let db;
  try {
    db = await connectToMongoDB();
    await seedDatasetIfNeeded(db, agentName);
  } catch (err: any) {
    console.error(`❌ Error al conectar o sembrar en MongoDB:`, err.message);
    process.exit(1);
  }

  const collection = db.collection('OptimizationDataset');
  const examples = await collection.find({ agentName }).toArray();

  if (examples.length === 0) {
    console.error(`❌ Error: No hay datos de entrenamiento disponibles en MongoDB.`);
    process.exit(1);
  }

  console.log(`📊 Cargados ${examples.length} ejemplos de entrenamiento.`);

  // Load baseline prompt JSON
  let signature;
  try {
    signature = PromptLoader.getPrompt(agentName);
  } catch (err: any) {
    console.error(`❌ Error al cargar prompt local:`, err.message);
    process.exit(1);
  }

  // Create reflection model (defaults to gemini-2.5-flash to prevent quota issues)
  const reflectionLlmInstance = new GeminiLlm({ model: reflectionModel });
  const reflectionLM = async (promptText: string): Promise<string> => {
    const request = {
      contents: [
        {
          role: 'user',
          parts: [{ text: promptText }]
        }
      ],
      config: {
        temperature: 0.7
      }
    };
    let output = '';
    for await (const chunk of reflectionLlmInstance.generateContentAsync(request)) {
      if (chunk.errorMessage) {
        throw new Error(`Reflection LLM Error: ${chunk.errorMessage}`);
      }
      if (chunk.content?.parts) {
        for (const part of chunk.content.parts) {
          if (typeof part === 'string') {
            output += part;
          } else if (part.text) {
            output += part.text;
          }
        }
      }
    }
    return output.trim();
  };

  const adapter = new AgentGEPAAdapter(agentName, provider, judgeProvider);

  console.log(`🚀 Iniciando el ciclo evolutivo de GEPA...`);
  console.log('--------------------------------------------------');

  try {
    const result = await optimize<CustomDataInst>({
      seedCandidate: {
        [agentName]: signature.instruction
      },
      trainset: examples.map(ex => ({
        inputs: ex.inputs,
        expectedOutput: ex.expectedOutput
      })),
      adapter,
      reflectionLM,
      maxMetricCalls: maxCalls,
      reflectionMinibatchSize: Math.min(3, examples.length),
      candidateSelectionStrategy: 'current-best',
      runDir: path.join(process.cwd(), 'data', 'gepa-runs', agentName + '-' + Date.now())
    });

    const optimizedPrompt = result.bestCandidate[agentName];
    const originalPrompt = signature.instruction;

    console.log('\n==================================================');
    console.log(`🏁 OPTIMIZACIÓN GEPA COMPLETADA`);
    console.log(`==================================================`);
    console.log(`📈 Score Inicial Estimado: ${result.allScores[0] ? (result.allScores[0] * 100).toFixed(1) : 'N/A'}%`);
    console.log(`📈 Score Mejor Candidato: ${(result.bestScore * 100).toFixed(1)}%`);
    console.log(`📋 Total Evaluaciones Realizadas: ${result.totalEvaluations}`);
    console.log(`==================================================`);

    if (optimizedPrompt !== originalPrompt) {
      console.log(`💾 Guardando prompt optimizado en: src/prompts/${agentName}.json`);
      signature.instruction = optimizedPrompt;
      PromptLoader.savePrompt(agentName, signature);
      console.log(`✔ Archivo actualizado con éxito.`);
      
      console.log(`\n🔍 DIFERENCIAS DETECTADAS EN LA INSTRUCCIÓN:`);
      console.log(`--------------------------------------------------`);
      console.log(`PROMPT ANTERIOR:\n${originalPrompt.substring(0, 300)}...\n`);
      console.log(`PROMPT NUEVO OPTIMIZADO:\n${optimizedPrompt.substring(0, 300)}...\n`);
      console.log(`--------------------------------------------------`);
    } else {
      console.log(`ℹ El prompt original ya era óptimo o no se encontraron candidatos con mejor puntaje.`);
    }

  } catch (err: any) {
    console.error(`❌ Error fatal durante la optimización:`, err);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error en scripts/optimize.ts:', err);
  process.exit(1);
});
