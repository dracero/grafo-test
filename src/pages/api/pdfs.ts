/**
 * GET /api/pdfs
 * Lists available PDFs in the configured folder.
 */
import type { APIRoute } from 'astro';
import path from 'path';
import { getServices } from '../../lib/services';
import { createLogger } from '../../services/logger';

const logger = createLogger();

export const GET: APIRoute = async () => {
  try {
    const { pdfProcessor } = await getServices();
    const files = await pdfProcessor.scanFolder();
    return new Response(JSON.stringify({ success: true, data: files.map((f: string) => path.basename(f)) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('API', 'Error listing PDFs', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
