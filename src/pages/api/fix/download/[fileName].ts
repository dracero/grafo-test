/**
 * GET /api/fix/download/[fileName]
 * Downloads the corrected PDF.
 */
import type { APIRoute } from 'astro';
import { correctedPdfs } from '../../../../lib/services';

export const GET: APIRoute = async ({ params }) => {
  const fileName = decodeURIComponent(params.fileName as string);
  const buffer = correctedPdfs.get(fileName);

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
