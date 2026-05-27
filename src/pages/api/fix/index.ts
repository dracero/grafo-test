/**
 * POST /api/fix
 * Runs the multi-agent correction pipeline with streaming response.
 */
import type { APIRoute } from 'astro';
import { getServices, originalPdfBuffers, correctedPdfs } from '../../../lib/services';
import { runCorrectionPipeline } from '../../../services/multi-agent-service';
import { generateCorrectedProgramPDF, parseCorrections } from '../../../services/pdf-generator';
import { createLogger } from '../../../services/logger';

const logger = createLogger();

export const POST: APIRoute = async ({ request }) => {
  try {
    const { graphBuilder } = await getServices();
    const body = await request.json();
    const { normativeDocument, programDocument } = body;

    if (!normativeDocument || !programDocument) {
      return new Response(JSON.stringify({ success: false, error: 'Se requieren "normativeDocument" y "programDocument"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('API', `Starting fix pipeline: ${programDocument} against ${normativeDocument}`);

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const pipeline = runCorrectionPipeline(normativeDocument, programDocument, graphBuilder);
          let correctedText = '';

          for await (const update of pipeline) {
            controller.enqueue(encoder.encode(
              JSON.stringify({ type: 'progress', step: update.step, content: update.content, isFinal: update.isFinal }) + '\n'
            ));
            if (update.step === 'ProgramFixerAgent' && update.isFinal) {
              correctedText = update.content;
            }
          }

          if (!correctedText) {
            throw new Error('El agente corrector no generó ningún contenido corregido.');
          }

          const corrections = parseCorrections(correctedText);
          logger.info('API', `Parsed ${corrections.length} structured corrections from agent output`);

          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'progress', step: 'PDFGenerator', content: `Generando PDF con formato original + ${corrections.length} correcciones...`, isFinal: false }) + '\n'
          ));

          const originalBuffer = originalPdfBuffers.get(programDocument) || null;
          if (!originalBuffer) {
            logger.warn('API', `Original PDF buffer not found for "${programDocument}".`);
          }

          const pdfBuffer = await generateCorrectedProgramPDF(programDocument, originalBuffer, corrections, correctedText);
          const downloadName = programDocument.replace(/\.pdf$/i, '') + '_corregido.pdf';
          correctedPdfs.set(downloadName, pdfBuffer);

          controller.enqueue(encoder.encode(
            JSON.stringify({
              type: 'complete',
              downloadUrl: `/api/fix/download/${encodeURIComponent(downloadName)}`,
              correctedText,
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
