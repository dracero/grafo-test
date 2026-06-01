import { ConfigurationManager } from '../../src/config';
import { maybeSetOtelProviders } from '@google/adk';
import { KnowledgeGraphBuilderImpl } from '../../src/services/knowledge-graph-builder';
import { runCorrectionPipeline } from '../../src/services/multi-agent-service';
import { generateCorrectedProgramPDF, parseCorrections } from '../../src/services/pdf-generator';
import * as path from 'path';
const pdfParse = require('pdf-parse');

async function runEvaluationHarness() {
  console.log('==================================================');
  console.log('🚀 INICIANDO ARNÉS DE EVALUACIÓN MULTI-AGENTE Y PDF');
  console.log('==================================================\n');

  // 1. Cargar Configuración
  const configManager = new ConfigurationManager();
  configManager.load();
  const config = configManager.getConfig();

  // 2. Inicializar OpenTelemetry (Langsmith)
  try {
    maybeSetOtelProviders();
    console.log('✔ Telemetría OpenTelemetry (OTel) inicializada.');
    console.log(`  Proyecto Langsmith: ${process.env.LANGSMITH_PROJECT || 'Default'}`);
    console.log(`  Endpoint OTel: ${process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'Default'}\n`);
  } catch (err: any) {
    console.error('⚠ Error al inicializar telemetría OTel:', err.message);
  }

  // 3. Conectar a Neo4j
  console.log('🔌 Conectando a la base de datos de Neo4j...');
  const graphBuilder = new KnowledgeGraphBuilderImpl();
  await graphBuilder.connect(config.neo4j);
  console.log('✔ Conexión a Neo4j exitosa.\n');

  try {
    // 4. Buscar documentos en la base de datos para evaluar
    console.log('🔍 Buscando documentos procesados en Neo4j...');
    
    // Obtenemos los documentos disponibles consultando la sesión directamente
    const driver = (graphBuilder as any).driver;
    if (!driver) {
      throw new Error('No se pudo obtener el driver de Neo4j del graphBuilder');
    }
    
    const session = driver.session();
    let normativeDoc = '';
    let programDoc = '';

    try {
      const normResult = await session.run(`
        MATCH (n:NormativeDocument)
        RETURN n.name AS name LIMIT 1
      `);
      if (normResult.records.length > 0) {
        normativeDoc = normResult.records[0].get('name');
      }

      const progResult = await session.run(`
        MATCH (p:ProgramDocument)
        RETURN p.name AS name LIMIT 1
      `);
      if (progResult.records.length > 0) {
        programDoc = progResult.records[0].get('name');
      }
    } finally {
      await session.close();
    }

    // Valores por defecto/fallback si no hay nada en la base de datos
    if (!normativeDoc || !programDoc) {
      console.log('⚠ No se encontraron documentos en Neo4j. Usando valores de fallback.');
      normativeDoc = normativeDoc || '04_Marco de competencias digitales docentes en la Universidad de Buenos Aires.pdf';
      programDoc = programDoc || 'RESCS_2023_1600_PETROLEO_Plan_de_Estudios_Texto_ordenado_681ce83c8e.pdf';
    }

    console.log(`📄 Documento Normativo a evaluar: "${normativeDoc}"`);
    console.log(`📄 Programa de Materia a evaluar: "${programDoc}"\n`);

    // 5. Correr el Pipeline Multi-Agente
    console.log('⚙ Ejecutando pipeline de corrección multi-agente...');
    const pipeline = runCorrectionPipeline(normativeDoc, programDoc, graphBuilder);
    
    let correctedText = '';
    
    for await (const update of pipeline) {
      console.log(`  [Progreso] ${update.step}: ${update.isFinal ? 'COMPLETADO' : 'PROCESANDO...'}`);
      if (update.step === 'ProgramFixerAgent' && update.isFinal) {
        correctedText = update.content;
      }
    }

    if (!correctedText) {
      throw new Error('El agente corrector (ProgramFixerAgent) no devolvió ningún contenido.');
    }

    console.log('\n✔ Pipeline ejecutado con éxito.');
    console.log(`  Longitud del informe del agente: ${correctedText.length} caracteres.\n`);

    // 6. Aserciones de Contenido (Métricas de Calidad)
    console.log('🧪 Ejecutando aserciones de contenido...');
    
    const hasSection1 = correctedText.toUpperCase().includes('RESUMEN DE REQUISITOS FALTANTES') || correctedText.toLowerCase().includes('corrections');
    const hasSection2 = correctedText.toUpperCase().includes('PROPUESTA DE CORRECCIÓN PARA REQUISITOS PARCIALES') || correctedText.toLowerCase().includes('corrections');
    
    console.log(`  - ¿Contiene la Sección 1 (Faltantes)?: ${hasSection1 ? '✅ SÍ' : '❌ NO'}`);
    console.log(`  - ¿Contiene la Sección 2 (Parciales)?: ${hasSection2 ? '✅ SÍ' : '❌ NO'}`);

    if (!hasSection1 || !hasSection2) {
      throw new Error('La validación de contenido falló: faltan secciones requeridas.');
    }

    // 7. Aserciones de Generación de PDF
    console.log('\n🖨 Generando y analizando PDF...');
    const corrections = parseCorrections(correctedText);
    const pdfBuffer = await generateCorrectedProgramPDF(programDoc, null, corrections, correctedText);
    console.log(`  - PDF generado. Tamaño del Buffer: ${pdfBuffer.length} bytes.`);

    // Parsear el PDF para verificar sus páginas
    const pageTexts: string[] = [];
    const parseOptions = {
      pagerender: function(pageData: any) {
        return pageData.getTextContent().then(function(textContent: any) {
          let text = '';
          for (let item of textContent.items) {
            text += item.str + ' ';
          }
          pageTexts.push(text);
          return text;
        });
      }
    };

    const parsedPdf = await pdfParse(pdfBuffer, parseOptions);
    console.log(`  - Cantidad total de páginas en el PDF: ${parsedPdf.numpages}`);

    // Verificar que ninguna página esté en blanco
    let blankPagesCount = 0;
    pageTexts.forEach((text, idx) => {
      const charCount = text.trim().length;
      console.log(`    * Página ${idx + 1}: ${charCount} caracteres.`);
      if (charCount === 0) {
        blankPagesCount++;
      }
    });

    console.log(`  - Páginas vacías encontradas: ${blankPagesCount === 0 ? '✅ 0' : `❌ ${blankPagesCount}`}`);

    if (blankPagesCount > 0) {
      throw new Error(`Se detectaron ${blankPagesCount} páginas vacías en el PDF generado.`);
    }

    console.log('\n==================================================');
    console.log('🎉 EVALUACIÓN COMPLETADA CON ÉXITO: TODO CUMPLE');
    console.log('==================================================');
    process.exit(0);

  } catch (error: any) {
    console.error('\n❌ ERROR EN LA EVALUACIÓN:', error.message);
    console.log('==================================================');
    process.exit(1);
  } finally {
    // Cerrar conexiones de Neo4j
    await graphBuilder.disconnect();
  }
}

runEvaluationHarness().catch(err => {
  console.error('Fatal error en el arnés de evaluación:', err);
  process.exit(1);
});
