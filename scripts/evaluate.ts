import dotenv from 'dotenv';
import path from 'path';
import { connectToMongoDB } from '../src/lib/mongodb';
import { getLlmProvider } from '../src/services/llm-provider';
import { PromptLoader } from '../src/services/prompt-loader';

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

// Seed data if DB is empty, ensuring the CLI is testable immediately
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
        sourceRunId: "mock-run-eval-1",
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
        sourceRunId: "mock-run-eval-2",
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
        sourceRunId: "mock-run-eval-3",
        curatedAt: now,
        updatedAt: now
      }
    ];
  } else {
    // Generic seed fallback for other agents
    seedExamples = [
      {
        agentName,
        inputs: {
          inputData: `Ejemplo de datos de entrada para ${agentName}.`,
          targetLangName: "Español"
        },
        expectedOutput: `Respuesta de referencia esperada para ${agentName} acorde a la entrada de ejemplo.`,
        sourceRunId: "mock-run-eval-generic",
        curatedAt: now,
        updatedAt: now
      }
    ];
  }

  await collection.insertMany(seedExamples);
  console.log(`✔ Sembrados ${seedExamples.length} ejemplos exitosamente.`);
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
    // Simple fallback parser
    const scoreMatch = output.match(/"score"\s*:\s*([\d.]+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5;
    return {
      score: isNaN(score) ? 0.0 : score,
      reason: `Error al parsear respuesta JSON del juez: ${err.message}. Salida cruda: ${output}`
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  let agentName = '';
  let provider = 'gemini';
  let judgeProvider = 'gemini';

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
    }
  }

  if (!agentName) {
    console.error(`❌ Error: Se debe especificar el parámetro --agent.`);
    console.log(`Agentes disponibles:`);
    AVAILABLE_AGENTS.forEach(a => console.log(`  - ${a}`));
    console.log(`Ejemplo: npx tsx scripts/evaluate.ts --agent ComplianceValidatorAgent`);
    process.exit(1);
  }

  if (!AVAILABLE_AGENTS.includes(agentName)) {
    console.error(`❌ Error: Agente "${agentName}" no reconocido.`);
    console.log(`Elige uno de: ${AVAILABLE_AGENTS.join(', ')}`);
    process.exit(1);
  }

  console.log(`🔍 Evaluando agente: ${agentName}`);
  console.log(`🔌 Provider Tarea: ${provider} | Juez: ${judgeProvider}`);

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
    console.error(`❌ Error: No se encontraron ejemplos en MongoDB para el agente: ${agentName}`);
    process.exit(1);
  }

  console.log(`📊 Cargados ${examples.length} ejemplos desde MongoDB.`);

  // Load baseline signature
  let signature;
  try {
    signature = PromptLoader.getPrompt(agentName);
  } catch (err: any) {
    console.error(`❌ Error al cargar prompt local:`, err.message);
    process.exit(1);
  }

  console.log(`✍ Prompt Base (primeros 150 caracteres): "${signature.instruction.substring(0, 150)}..."`);
  console.log('--------------------------------------------------\n');

  let totalScore = 0;
  const results: any[] = [];

  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i];
    console.log(`[Ejemplo ${i + 1}/${examples.length}] ID: ${ex._id || 'mock-id'}`);
    
    try {
      console.log(`  🚀 Ejecutando agente con inputs...`);
      const output = await runAgent(provider, agentName, ex.inputs, signature.instruction);
      
      console.log(`  ⚖ Calificando salida con el Juez LLM...`);
      const { score, reason } = await runJudge(judgeProvider, ex.inputs, ex.expectedOutput, output);
      
      console.log(`  🎯 Score obtenido: ${score} - Razón: ${reason}`);
      console.log(`  --------------------------------------------------`);
      
      totalScore += score;
      results.push({
        id: ex._id,
        score,
        reason,
        generated: output,
        expected: ex.expectedOutput
      });
    } catch (err: any) {
      console.error(`  ❌ Error durante la evaluación del ejemplo:`, err.message);
      console.log(`  --------------------------------------------------`);
      results.push({
        id: ex._id,
        score: 0,
        reason: `Error: ${err.message}`,
        generated: '',
        expected: ex.expectedOutput
      });
    }
  }

  const avgScore = totalScore / examples.length;
  console.log(`\n==================================================`);
  console.log(`🏁 RESUMEN DE EVALUACIÓN PARA: ${agentName}`);
  console.log(`==================================================`);
  console.log(`📈 Score Promedio: ${(avgScore * 100).toFixed(2)}%`);
  console.log(`📋 Ejemplos evaluados: ${examples.length}`);
  console.log(`📊 Desglose de scores:`);
  results.forEach((r, idx) => {
    console.log(`   - Ejemplo ${idx + 1}: ${(r.score * 100).toFixed(0)}% (${r.reason.substring(0, 80)}...)`);
  });
  console.log(`==================================================\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error en scripts/evaluate.ts:', err);
  process.exit(1);
});
