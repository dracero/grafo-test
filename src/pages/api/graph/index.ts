/**
 * GET /api/graph
 * Returns the full graph (nodes + edges) with optional filters.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../../lib/services';

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const userEmail = locals.user?.email;
    if (!userEmail) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { visualizationService } = await getServices();
    const url = new URL(request.url);
    const filters: any = {};

    const entityTypes = url.searchParams.get('entityTypes');
    if (entityTypes) filters.entityTypes = entityTypes.split(',');

    const sourceDocuments = url.searchParams.get('sourceDocuments');
    if (sourceDocuments) filters.sourceDocuments = sourceDocuments.split(',');

    const maxNodes = url.searchParams.get('maxNodes');
    if (maxNodes) filters.maxNodes = parseInt(maxNodes, 10);

    const graphData = await visualizationService.getGraph(filters, userEmail);
    const vizData = await visualizationService.generateVisualizationData(graphData);

    return new Response(JSON.stringify({
      success: true,
      data: vizData,
      stats: {
        nodeCount: vizData.nodes.length,
        edgeCount: vizData.edges.length,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
