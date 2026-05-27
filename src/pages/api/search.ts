/**
 * POST /api/search
 * Vector similarity search. Body: { query: string, limit?: number }
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../lib/services';
import { createLogger } from '../../services/logger';

const logger = createLogger();

export const POST: APIRoute = async ({ request }) => {
  try {
    const { genkitEngine } = await getServices();
    const body = await request.json();
    const { query, limit = 10 } = body;

    if (!query) {
      return new Response(JSON.stringify({ success: false, error: 'Query is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const results = await genkitEngine.retrieve(query, limit);

    return new Response(JSON.stringify({ success: true, data: results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('API', 'Error in vector search', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
