/**
 * GET /api/fix/download/[fileName]
 * Downloads the corrected PDF.
 */
import type { APIRoute } from 'astro';
import { correctedPdfs, getOriginalPdfBuffer, getServices } from '../../../../lib/services';
import { generateCorrectedProgramPDF } from '../../../../services/pdf-generator';
import { createLogger } from '../../../../services/logger';

const logger = createLogger();

export const GET: APIRoute = async ({ params, cookies, locals }) => {
  const userEmail = locals.user?.email;
  if (!userEmail) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const fileName = decodeURIComponent(params.fileName as string);
  let buffer = correctedPdfs.get(fileName);

  if (!buffer) {
    logger.info('DownloadAPI', `PDF buffer not found in-memory for "${fileName}". Attempting on-the-fly regeneration from Neo4j...`);
    try {
      const programDocument = fileName.replace(/_corregido\.pdf$/i, '.pdf');
      const originalBuffer = getOriginalPdfBuffer(programDocument);
      
      const { graphBuilder } = await getServices();
      const report = await graphBuilder.getLatestComparison(userEmail);
      
      if (report && report.programDocument === programDocument && (report as any).correctionsJson) {
        const corrections = JSON.parse((report as any).correctionsJson);
        // Enrich corrections with evidence/suggestion from comparison results
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
        const correctedText = (report as any).correctedText || '';
        const lang = cookies.get('app_lang')?.value || 'es';
        
        logger.info('DownloadAPI', `Regenerating corrected PDF for "${programDocument}" with ${corrections.length} corrections`);
        buffer = await generateCorrectedProgramPDF(programDocument, originalBuffer, corrections, correctedText, lang);
        correctedPdfs.set(fileName, buffer);
      } else {
        logger.warn('DownloadAPI', `No stored report or corrections found in Neo4j for program: ${programDocument}`);
      }
    } catch (err: any) {
      logger.error('DownloadAPI', `Failed to regenerate PDF on the fly: ${err.message}`, err);
    }
  }

  if (!buffer) {
    return new Response(JSON.stringify({ success: false, error: 'Archivo no encontrado o expirado.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
  });
};
