/**
 * POST /api/fix
 * Runs the multi-agent correction pipeline with streaming response.
 */
import type { APIRoute } from 'astro';
import { getServices, getOriginalPdfBuffer, correctedPdfs } from '../../../lib/services';
import { runCorrectionPipeline } from '../../../services/multi-agent-service';
import { generateCorrectedProgramPDF, parseCorrections } from '../../../services/pdf-generator';
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
          // Check if we already have the comparison and corrections in Neo4j
          const report = await graphBuilder.getLatestComparison(userEmail);
          if (report && report.programDocument === programDocument && report.normativeDocument === normativeDocument && (report as any).correctionsJson) {
            logger.info('API', `Found stored corrections for "${programDocument}" in Neo4j. Skipping agents pipeline.`);
            
            // Stream the cached progress steps quickly so the UI updates
            const cachedSteps = [
              { step: 'NormativeOntologyAgent', content: 'Cargado de caché' },
              { step: 'ProgramOntologyAgent', content: 'Cargado de caché' },
              { step: 'StructureAnalyzerAgent', content: 'Cargado de caché' },
              { step: 'ComplianceGapsAgent', content: 'Cargado de caché' },
              { step: 'ComplianceValidatorAgent', content: 'Cargado de caché' },
              { step: 'ProgramFixerAgent', content: (report as any).correctedText || '' }
            ];

            for (const stepInfo of cachedSteps) {
              controller.enqueue(encoder.encode(
                JSON.stringify({ type: 'progress', step: stepInfo.step, content: stepInfo.content, isFinal: true }) + '\n'
              ));
              // Small delay to simulate rendering smoothly
              await new Promise(r => setTimeout(r, 50));
            }

            const corrections = JSON.parse((report as any).correctionsJson);
            const originalBuffer = getOriginalPdfBuffer(programDocument);
            const pdfBuffer = await generateCorrectedProgramPDF(programDocument, originalBuffer, corrections, (report as any).correctedText || '', lang);
            const downloadName = programDocument.replace(/\.pdf$/i, '') + '_corregido.pdf';
            correctedPdfs.set(downloadName, pdfBuffer);

            controller.enqueue(encoder.encode(
              JSON.stringify({
                type: 'complete',
                downloadUrl: `/api/fix/download/${encodeURIComponent(downloadName)}`,
                correctedText: (report as any).correctedText || '',
              }) + '\n'
            ));
            
            controller.close();
            return;
          }

          const pipeline = runCorrectionPipeline(normativeDocument, programDocument, graphBuilder, provider, lang, userEmail);
          let correctedText = '';
          let validatedComplianceText = '';

          for await (const update of pipeline) {
            controller.enqueue(encoder.encode(
              JSON.stringify({ type: 'progress', step: update.step, content: update.content, isFinal: update.isFinal }) + '\n'
            ));
            if (update.step === 'ProgramFixerAgent' && update.isFinal) {
              correctedText = update.content;
            }
            if (update.step === 'ComplianceValidatorAgent' && update.isFinal) {
              validatedComplianceText = update.content;
            }
          }

          if (!correctedText) {
            throw new Error('El agente corrector no generó ningún contenido corregido.');
          }

          const corrections = parseCorrections(correctedText);
          logger.info('API', `Parsed ${corrections.length} structured corrections from agent output`);

          let validatedGaps: any[] = [];
          let excludedGaps: any[] = [];
          if (validatedComplianceText) {
            try {
              const cleanedText = validatedComplianceText.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
              const parsed = JSON.parse(cleanedText);
              validatedGaps = parsed.validatedGaps || [];
              excludedGaps = parsed.excludedGaps || [];
              logger.info('API', `Parsed validated compliance analysis: ${validatedGaps.length} validated, ${excludedGaps.length} excluded`);
            } catch (err) {
              logger.warn('API', 'Could not parse validated compliance analysis output as JSON', err as Error);
            }
          }

          // Update report results based on validated compliance gaps
          const comparisonReport = await graphBuilder.getLatestComparison(userEmail);
          if (comparisonReport && comparisonReport.programDocument === programDocument && comparisonReport.normativeDocument === normativeDocument) {
            const validatedGapsMap = new Map(validatedGaps.map((g: any) => [g.id, g]));
            const excludedGapsMap = new Map(excludedGaps.map((g: any) => [g.id, g]));

            for (const result of comparisonReport.results) {
              const reqId = result.item.id;
              if (excludedGapsMap.has(reqId)) {
                const excl = excludedGapsMap.get(reqId);
                result.status = 'covered';
                result.evidence = excl.reason || result.evidence;
                result.suggestion = 'Ninguna';
              } else if (validatedGapsMap.has(reqId)) {
                const val = validatedGapsMap.get(reqId);
                result.status = val.status as 'partial' | 'missing';
                result.evidence = val.evidence || result.evidence;
                result.suggestion = val.suggestion || result.suggestion;
              }
            }

            // Recalculate summary metrics
            const covered = comparisonReport.results.filter((r) => r.status === 'covered').length;
            const partial = comparisonReport.results.filter((r) => r.status === 'partial').length;
            const missing = comparisonReport.results.filter((r) => r.status === 'missing').length;
            const total   = comparisonReport.results.length;
            const coveragePercent = total > 0
              ? Math.round(((covered + partial * 0.5) / total) * 100)
              : 0;

            comparisonReport.summary = { total, covered, partial, missing, coveragePercent };

            // Save the updated comparison report back to Neo4j
            await graphBuilder.saveComparisonReport(comparisonReport, userEmail);
            logger.info('API', 'Updated comparison report with validated/excluded gaps saved in Neo4j during fix');
          }

          // Save corrections list to the graph
          await graphBuilder.saveCorrections(programDocument, corrections, correctedText, userEmail);

          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'progress', step: 'PDFGenerator', content: `Generando PDF con formato original + ${corrections.length} correcciones...`, isFinal: false }) + '\n'
          ));

          const originalBuffer = getOriginalPdfBuffer(programDocument);
          if (!originalBuffer) {
            logger.warn('API', `Original PDF buffer not found for "${programDocument}" (neither in-memory nor on disk).`);
          }

          const pdfBuffer = await generateCorrectedProgramPDF(programDocument, originalBuffer, corrections, correctedText, lang);
          const downloadName = programDocument.replace(/\.pdf$/i, '') + '_corregido.pdf';
          correctedPdfs.set(downloadName, pdfBuffer);

          const finalReport = await graphBuilder.getLatestComparison(userEmail);

          controller.enqueue(encoder.encode(
            JSON.stringify({
              type: 'complete',
              downloadUrl: `/api/fix/download/${encodeURIComponent(downloadName)}`,
              correctedText,
              data: finalReport || comparisonReport,
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
