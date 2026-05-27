/**
 * GET  /api/compare/latest — Returns the latest comparison report from Neo4j
 * POST /api/compare       — Runs a full comparison between normative and program PDFs
 */
import type { APIRoute } from 'astro';
import { getServices, originalPdfBuffers } from '../../../lib/services';
import { createLogger } from '../../../services/logger';

const logger = createLogger();
import pdfParse from 'pdf-parse';

export const GET: APIRoute = async () => {
  try {
    const { graphBuilder } = await getServices();
    const report = await graphBuilder.getLatestComparison();
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

export const POST: APIRoute = async ({ request }) => {
  try {
    const { comparisonService, graphBuilder } = await getServices();
    const formData = await request.formData();

    const normFile = formData.get('normative') as File | null;
    const progFile = formData.get('program') as File | null;

    if (!normFile || !progFile) {
      return new Response(JSON.stringify({ success: false, error: 'Se requieren dos archivos: "normative" y "program"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('Comparison', `Comparing: ${normFile.name} vs ${progFile.name}`);

    // Read file buffers
    const normBuffer = Buffer.from(await normFile.arrayBuffer());
    const progBuffer = Buffer.from(await progFile.arrayBuffer());

    // Store original PDF buffers for later use by the fix pipeline
    originalPdfBuffers.set(progFile.name, progBuffer);
    originalPdfBuffers.set(normFile.name, normBuffer);
    logger.info('API', `Stored original PDF buffers: ${progFile.name} (${progBuffer.length} bytes), ${normFile.name} (${normBuffer.length} bytes)`);

    const normPdf = await pdfParse(normBuffer);
    const progPdf = await pdfParse(progBuffer);

    if (!normPdf.text?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'No se pudo extraer texto del documento normativo' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!progPdf.text?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'No se pudo extraer texto del programa' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const clearPrevious = formData.get('clearPrevious') === 'true';
    const report = await comparisonService.fullComparison(normPdf.text, progPdf.text, normFile.name, progFile.name);

    try {
      if (clearPrevious) {
        await graphBuilder.clearPreviousComparisons();
        logger.info('API', 'Cleared previous comparisons from Neo4j');
      }
      await graphBuilder.saveComparisonReport(report);
      logger.info('API', 'Successfully saved comparison report to Neo4j');
    } catch (err: any) {
      logger.error('API', 'Failed to save comparison to graph', err);
    }

    return new Response(JSON.stringify({ success: true, data: report }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('API', 'Error in comparison', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
