/**
 * GET /api/compare/full-report-pdf
 * Retrieves the latest comparison report and generates a complete PDF
 * showing all items (covered, partial, missing) — matching the on-screen view.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../../lib/services';
import { generateFullReportPDF } from '../../../services/full-report-pdf-generator';
import { createLogger } from '../../../services/logger';

const logger = createLogger();

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
    logger.info('API', `Fetching latest comparison report to generate full report PDF for user ${userEmail}...`);

    const report = await graphBuilder.getLatestComparison(userEmail);

    if (!report) {
      return new Response(JSON.stringify({ success: false, error: 'No se encontró ningún informe de comparación reciente.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Parse corrections if available
    let corrections: any[] = [];
    if (report.correctionsJson) {
      try {
        corrections = JSON.parse(report.correctionsJson);
      } catch (e) {
        logger.warn('API', 'Could not parse correctionsJson for full report PDF');
      }
    }

    const pdfBuffer = await generateFullReportPDF(report, corrections);
    const downloadName = report.programDocument.replace(/\.pdf$/i, '') + '_informe_completo.pdf';

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${downloadName}"`,
      },
    });
  } catch (error: any) {
    logger.error('API', 'Error generating full report PDF endpoint', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
