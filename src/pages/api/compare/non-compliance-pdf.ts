/**
 * GET /api/compare/non-compliance-pdf
 * Retrieves the latest comparison report and returns the non-conformity PDF.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../../lib/services';
import { generateNonCompliancePDF } from '../../../services/non-compliance-pdf-generator';
import { createLogger } from '../../../services/logger';

const logger = createLogger();

export const GET: APIRoute = async () => {
  try {
    const { graphBuilder } = await getServices();
    logger.info('API', 'Fetching latest comparison report to generate non-conformity PDF...');
    
    const report = await graphBuilder.getLatestComparison();

    if (!report) {
      return new Response(JSON.stringify({ success: false, error: 'No se encontró ningún informe de comparación reciente.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const pdfBuffer = await generateNonCompliancePDF(report);
    const downloadName = report.programDocument.replace(/\.pdf$/i, '') + '_no_conformidades.pdf';

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${downloadName}"`,
      },
    });
  } catch (error: any) {
    logger.error('API', 'Error generating non-compliance PDF endpoint', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
