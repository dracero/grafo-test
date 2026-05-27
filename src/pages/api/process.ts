/**
 * POST /api/process
 * Triggers PDF processing for all PDFs in the configured folder.
 */
import type { APIRoute } from 'astro';
import path from 'path';
import { getServices } from '../../lib/services';
import { createLogger } from '../../services/logger';

const logger = createLogger();

export const POST: APIRoute = async () => {
  try {
    const { pdfProcessor, genkitEngine, graphBuilder } = await getServices();
    logger.info('API', 'Starting PDF processing...');

    const files = await pdfProcessor.scanFolder();
    const results: any[] = [];

    for (const file of files) {
      try {
        const pdfResult = await pdfProcessor.extractText(file);
        if (!pdfResult.success || !pdfResult.text) {
          results.push({ file, status: 'error', error: pdfResult.error || 'No text extracted' });
          continue;
        }
        const analysis = await genkitEngine.analyzeText(pdfResult.text);
        const stats = await graphBuilder.processAnalysisResult(analysis, path.basename(file));
        results.push({ file: path.basename(file), status: 'success', stats });
      } catch (err: any) {
        results.push({ file: path.basename(file), status: 'error', error: err.message });
      }
    }

    return new Response(JSON.stringify({ success: true, data: { processed: results.length, results } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('API', 'Error processing PDFs', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
