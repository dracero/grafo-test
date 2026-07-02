/**
 * GET  /api/compare/latest — Returns the latest comparison report from Neo4j
 * POST /api/compare       — Runs a full comparison between normative and program PDFs
 */
import type { APIRoute } from 'astro';
import { getServices, originalPdfBuffers, savePdfBufferToDisk, correctedPdfs } from '../../../lib/services';
import { createLogger } from '../../../services/logger';
import { runCorrectionPipeline } from '../../../services/multi-agent-service';
import { generateCorrectedProgramPDF, parseCorrections } from '../../../services/pdf-generator';
import { normalizeStatus } from '../../../services/comparison';

const logger = createLogger();
import pdfParse from 'pdf-parse';

export const GET: APIRoute = async ({ locals }) => {
  try {
    const userEmail = locals.user?.email;
    if (!userEmail) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { graphBuilder } = await getServices();
    const report = await graphBuilder.getLatestComparison(userEmail);
    return new Response(JSON.stringify({ success: true, data: report || null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('API', 'Error fetching latest comparison', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  try {
    const userEmail = locals.user?.email;
    if (!userEmail) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { comparisonService, graphBuilder } = await getServices();
    const formData = await request.formData();

    const normFile = formData.get('normative') as File | null;
    const progFile = formData.get('program') as File | null;
    const provider = formData.get('provider') as string | null || undefined;
    const lang = cookies.get('app_lang')?.value || 'es';

    if (!normFile || !progFile) {
      return new Response(JSON.stringify({ success: false, error: 'Se requieren dos archivos: "normative" y "program"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('Comparison', `Comparing: ${normFile.name} vs ${progFile.name} using provider: ${provider || 'default'}`);

    // Read file buffers
    const normBuffer = Buffer.from(await normFile.arrayBuffer());
    const progBuffer = Buffer.from(await progFile.arrayBuffer());

    // Store original PDF buffers in-memory AND on disk for fix pipeline
    originalPdfBuffers.set(progFile.name, progBuffer);
    originalPdfBuffers.set(normFile.name, normBuffer);
    savePdfBufferToDisk(progFile.name, progBuffer);
    savePdfBufferToDisk(normFile.name, normBuffer);
    logger.info('API', `Stored original PDF buffers: ${progFile.name} (${progBuffer.length} bytes), ${normFile.name} (${normBuffer.length} bytes)`);

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // 1. Initial Comparison / Ontology Extraction
          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'progress', step: 'ComparisonService', content: 'Extrayendo ontología y comparando documentos...', isFinal: false }) + '\n'
          ));

          const normPdf = await pdfParse(normBuffer);
          const progPdf = await pdfParse(progBuffer);

          if (!normPdf.text?.trim()) {
            throw new Error('No se pudo extraer texto del documento normativo. El archivo puede estar dañado o ser un PDF basado en imágenes (escaneado).');
          }
          if (!progPdf.text?.trim()) {
            throw new Error('No se pudo extraer texto del programa. El archivo puede estar dañado o ser un PDF basado en imágenes (escaneado).');
          }

          // Detect PDFs where text extraction failed silently (e.g. scanned docs,
          // Google Drive "Print to PDF" artifacts, image-based PDFs).
          // A typical text PDF yields ~4-8 chars per KB of file size.
          const MIN_TEXT_CHARS = 500;
          const normTextLen = normPdf.text.trim().length;
          const progTextLen = progPdf.text.trim().length;

          if (normBuffer.length > 10_000 && normTextLen < MIN_TEXT_CHARS) {
            logger.warn('API', `Normative PDF text extraction yielded suspiciously little text: ${normTextLen} chars from ${normBuffer.length} bytes (${normFile.name})`);
            throw new Error(
              `El documento normativo "${normFile.name}" parece ser un PDF basado en imágenes o escaneado. ` +
              `Se extrajeron solo ${normTextLen} caracteres de un archivo de ${Math.round(normBuffer.length / 1024)}KB. ` +
              `Por favor, suba un PDF con texto seleccionable (no escaneado ni impreso desde Google Drive).`
            );
          }
          if (progBuffer.length > 10_000 && progTextLen < MIN_TEXT_CHARS) {
            logger.warn('API', `Program PDF text extraction yielded suspiciously little text: ${progTextLen} chars from ${progBuffer.length} bytes (${progFile.name})`);
            throw new Error(
              `El programa "${progFile.name}" parece ser un PDF basado en imágenes o escaneado. ` +
              `Se extrajeron solo ${progTextLen} caracteres de un archivo de ${Math.round(progBuffer.length / 1024)}KB. ` +
              `Por favor, suba un PDF con texto seleccionable (no escaneado ni impreso desde Google Drive).`
            );
          }

          logger.info('API', `PDF text extracted — Normative: ${normTextLen} chars (${Math.round(normBuffer.length / 1024)}KB), Program: ${progTextLen} chars (${Math.round(progBuffer.length / 1024)}KB)`);

          const clearPrevious = formData.get('clearPrevious') === 'true';
          const report = await comparisonService.fullComparison(
            normPdf.text,
            progPdf.text,
            normFile.name,
            progFile.name,
            provider,
            (content) => {
              controller.enqueue(encoder.encode(
                JSON.stringify({ type: 'progress', step: 'ComparisonService', content, isFinal: false }) + '\n'
              ));
            }
          );

          if (clearPrevious) {
            await graphBuilder.clearPreviousComparisons(userEmail);
            logger.info('API', 'Cleared previous comparisons from Neo4j');
          }
          await graphBuilder.saveComparisonReport(report, userEmail);
          logger.info('API', 'Successfully saved comparison report to Neo4j');

          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'progress', step: 'ComparisonService', content: 'Comparación inicial guardada. Iniciando pipeline de agentes...', isFinal: true }) + '\n'
          ));

          // 2. Run multi-agent pipeline
          const pipeline = runCorrectionPipeline(normFile.name, progFile.name, graphBuilder, provider, lang, userEmail);
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
            logger.warn('API', 'ProgramFixerAgent did not generate corrected content. Proceeding with comparison report only (0 corrections).');
            // Send a warning to the client but don't crash the pipeline
            controller.enqueue(encoder.encode(
              JSON.stringify({ type: 'progress', step: 'ProgramFixerAgent', content: '⚠️ El agente corrector no generó correcciones. Se mostrará solo el informe de comparación.', isFinal: true }) + '\n'
            ));
          }

          // 3. Parse corrections and update Neo4j
          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'progress', step: 'PDFGenerator', content: 'Procesando validación del agente y actualizando reporte...', isFinal: false }) + '\n'
          ));

          const corrections = parseCorrections(correctedText);

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
          const validatedGapsMap = new Map(validatedGaps.map((g: any) => [g.id, g]));
          const excludedGapsMap = new Map(excludedGaps.map((g: any) => [g.id, g]));

          for (const result of report.results) {
            const reqId = result.item.id;
            if (excludedGapsMap.has(reqId)) {
              const excl = excludedGapsMap.get(reqId);
              result.status = 'covered';
              result.evidence = excl.reason || result.evidence;
              result.suggestion = 'Ninguna';
            } else if (validatedGapsMap.has(reqId)) {
              const val = validatedGapsMap.get(reqId);
              result.status = normalizeStatus(val.status);
              result.evidence = val.evidence || result.evidence;
              result.suggestion = val.suggestion || result.suggestion;
            }
          }

          // Recalculate summary metrics
          const covered = report.results.filter((r) => r.status === 'covered').length;
          const partial = report.results.filter((r) => r.status === 'partial').length;
          const missing = report.results.filter((r) => r.status === 'missing').length;
          const total   = report.results.length;
          const coveragePercent = total > 0
            ? Math.round(((covered + partial * 0.5) / total) * 100)
            : 0;

          report.summary = { total, covered, partial, missing, coveragePercent };

          // Save the updated comparison report back to Neo4j
          await graphBuilder.saveComparisonReport(report, userEmail);
          logger.info('API', 'Updated comparison report with validated/excluded gaps saved in Neo4j');

          // Save corrections list to the graph
          await graphBuilder.saveCorrections(progFile.name, corrections, correctedText, userEmail);

          // Enrich corrections with evidence/suggestion from comparison results
          // so the PDF annex shows the same information as the HTML view
          const resultsMap = new Map(report.results.map(r => [r.item.id.toLowerCase(), r]));
          for (const corr of corrections) {
            if (corr.gapId) {
              const match = resultsMap.get(corr.gapId.toLowerCase());
              if (match) {
                corr.evidence = match.evidence || '';
                corr.suggestion = match.suggestion || '';
              }
            }
          }

          // Generate corrected PDF and cache it
          const pdfBuffer = await generateCorrectedProgramPDF(progFile.name, progBuffer, corrections, correctedText, lang, report.results);
          const downloadName = progFile.name.replace(/\.pdf$/i, '') + '_corregido.pdf';
          correctedPdfs.set(downloadName, pdfBuffer);
          logger.info('API', `Generated corrected PDF and cached as: ${downloadName} (${pdfBuffer.length} bytes)`);

          // Fetch the final saved report from Neo4j to return it
          const finalReport = await graphBuilder.getLatestComparison(userEmail);

          controller.enqueue(encoder.encode(
            JSON.stringify({
              type: 'complete',
              data: finalReport || report,
              downloadUrl: `/api/fix/download/${encodeURIComponent(downloadName)}`,
            }) + '\n'
          ));

          controller.close();
        } catch (error: any) {
          logger.error('API', 'Error running comparison or fix pipeline', error);
          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'error', error: error.message }) + '\n'
          ));
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    logger.error('API', 'Error starting comparison pipeline', error);
    return new Response(JSON.stringify({ type: 'error', error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
