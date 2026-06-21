/**
 * POST /api/graph/clear
 * Clears the entire Neo4j database (all nodes and relationships).
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../../lib/services';
import { createLogger } from '../../../services/logger';

const logger = createLogger();

export const POST: APIRoute = async ({ locals }) => {
  try {
    const userEmail = locals.user?.email;
    if (!userEmail) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { graphBuilder } = await getServices();
    logger.info('API', `Clearing database for user ${userEmail}...`);
    await graphBuilder.clearEntireDatabase(userEmail);
    return new Response(JSON.stringify({ success: true, message: 'Base de datos borrada por completo.' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    logger.error('API', 'Error clearing database', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
