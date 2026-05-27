/**
 * GET /api/node/[nodeId]
 * Returns details for a specific node.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../../lib/services';
import { createLogger } from '../../../services/logger';

const logger = createLogger();

export const GET: APIRoute = async ({ params }) => {
  try {
    const { visualizationService } = await getServices();
    const nodeId = params.nodeId as string;
    const details = await visualizationService.getNodeDetails(nodeId);
    return new Response(JSON.stringify({ success: true, data: details }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('API', `Error fetching node ${params.nodeId}`, error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
