/**
 * POST /api/fix
 * Runs the multi-agent correction pipeline with streaming response.
 */
import type { APIRoute } from 'astro';
import { getServices, getOriginalPdfBuffer, correctedPdfs } from '../../../lib/services';
import { generateCorrectedProgramPDF } from '../../../services/pdf-generator';
import { createLogger } from '../../../services/logger';

const logger = createLogger();

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  try {
    const userEmail = locals.user?.email;
    if (!userEmail) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { graphBuilder } = await getServices();
    const body = await request.json();
    const { normativeDocument, programDocument, provider } = body;
    const lang = body.lang || cookies.get('app_lang')?.value || 'es';

    if (!normativeDocument || !programDocument) {
      return new Response(JSON.stringify({ success: false, error: 'Se requieren "normativeDocument" y "programDocument"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('API', `Starting fix pipeline: ${programDocument} against ${normativeDocument} using provider: ${provider || 'default'} and language: ${lang} for user: ${userEmail}`);

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Fetch the latest comparison report from Neo4j
          const report = await graphBuilder.getLatestComparison(userEmail);
          if (!report || report.programDocument !== programDocument || report.normativeDocument !== normativeDocument) {
            throw new Error(lang === 'gl'
              ? 'Non se atopou un informe de comparación previo para este documento.'
              : 'No se encontró un reporte de comparación previo para este documento.');
          }

          // Construct corrections list from the report results if they don't exist in the database
          let corrections: any[] = [];
          let correctedText = (report as any).correctedText || '';

          if ((report as any).correctionsJson) {
            corrections = JSON.parse((report as any).correctionsJson);
          } else {
            // Construct corrections directly from report.results (HTML/database)
            const nonCompliances = report.results.filter(r => r.status === 'partial' || r.status === 'missing');
            corrections = nonCompliances.map(r => ({
              gapId: r.item.id,
              section: r.item.category || 'General',
              action: r.status === 'missing' ? 'agregar' : 'enriquecer',
              evidence: r.evidence || '',
              suggestion: '', // set to empty to avoid duplicate printing in generateAppendixPDF
              justification: lang === 'gl'
                ? 'Adecuación requerida para cumplir coa normativa de referencia.'
                : 'Adecuación requerida para cumplir con la normativa de referencia.',
              correctedText: r.suggestion || (lang === 'gl'
                ? 'Incorporar este aspecto de forma explícita na sección correspondente do programa.'
                : 'Incorporar este aspecto de forma explícita en la sección correspondiente del programa.'),
              priority: r.status === 'missing' ? 'alta' : 'media'
            }));
            correctedText = JSON.stringify({ corrections }, null, 2);
            
            // Save corrections list to the graph
            await graphBuilder.saveCorrections(programDocument, corrections, correctedText, userEmail);
            logger.info('API', `Generated and stored corrections from ${corrections.length} non-compliance gaps in Neo4j.`);
          }

          // Stream the cached progress steps quickly so the UI updates
          const cachedSteps = [
            { step: 'NormativeOntologyAgent', content: 'Cargado de caché' },
            { step: 'ProgramOntologyAgent', content: 'Cargado de caché' },
            { step: 'StructureAnalyzerAgent', content: 'Cargado de caché' },
            { step: 'ComplianceGapsAgent', content: 'Cargado de caché' },
            { step: 'ComplianceValidatorAgent', content: 'Cargado de caché' },
            { step: 'ProgramFixerAgent', content: correctedText }
          ];

          for (const stepInfo of cachedSteps) {
            controller.enqueue(encoder.encode(
              JSON.stringify({ type: 'progress', step: stepInfo.step, content: stepInfo.content, isFinal: true }) + '\n'
            ));
            // Small delay to simulate rendering smoothly
            await new Promise(r => setTimeout(r, 50));
          }

          // Enrich corrections with evidence/suggestion from comparison results if needed
          const resultsMap = new Map(report.results.map(r => [r.item.id.toLowerCase(), r]));
          for (const corr of corrections) {
            if (corr.gapId) {
              const match = resultsMap.get(corr.gapId.toLowerCase());
              if (match) {
                corr.evidence = match.evidence || '';
                if (corr.suggestion !== '') {
                  corr.suggestion = '';
                }
              }
            }
          }

          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'progress', step: 'PDFGenerator', content: `Generando PDF con formato original + ${corrections.length} correcciones...`, isFinal: false }) + '\n'
          ));

          const originalBuffer = getOriginalPdfBuffer(programDocument);
          if (!originalBuffer) {
            logger.warn('API', `Original PDF buffer not found for "${programDocument}" (neither in-memory nor on disk).`);
          }

          const pdfBuffer = await generateCorrectedProgramPDF(programDocument, originalBuffer, corrections, correctedText, lang, undefined);
          const downloadName = programDocument.replace(/\.pdf$/i, '') + '_corregido.pdf';
          correctedPdfs.set(downloadName, pdfBuffer);

          controller.enqueue(encoder.encode(
            JSON.stringify({
              type: 'complete',
              downloadUrl: `/api/fix/download/${encodeURIComponent(downloadName)}`,
              correctedText,
              data: report,
            }) + '\n'
          ));
          
          controller.close();
        } catch (error: any) {
          logger.error('API', 'Error running fix pipeline', error);
          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'error', error: error.message }) + '\n'
          ));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    logger.error('API', 'Error starting fix pipeline', error);
    return new Response(JSON.stringify({ type: 'error', error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
