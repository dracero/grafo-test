/**
 * GET /api/compare/latest
 * Returns the latest comparison report from the graph.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../../lib/services';
import { createLogger } from '../../../services/logger';

const logger = createLogger();

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
