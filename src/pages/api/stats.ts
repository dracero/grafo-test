/**
 * GET /api/stats
 * Returns graph statistics.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../lib/services';
import { createLogger } from '../../services/logger';

const logger = createLogger();

export const GET: APIRoute = async () => {
  try {
    const { visualizationService } = await getServices();
    const neo4jDriver = (visualizationService as any).driver;

    if (!neo4jDriver) {
      return new Response(JSON.stringify({ success: false, error: 'Neo4j not connected' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const neo4jModule = await import('neo4j-driver');
    const session = neo4jDriver.session({ defaultAccessMode: neo4jModule.default.session.READ });

    try {
      const nodeCount = await session.run('MATCH (n) RETURN count(n) AS count');
      const relCount = await session.run('MATCH ()-[r]->() RETURN count(r) AS count');
      const typeBreakdown = await session.run(`
        MATCH (n)
        WITH labels(n) AS lbls, COALESCE(n.type, labels(n)[0]) AS type
        RETURN type, count(*) AS count
        ORDER BY count DESC
      `);
      const docBreakdown = await session.run(`
        MATCH (n)
        WHERE n.documents IS NOT NULL
        UNWIND n.documents AS doc
        RETURN doc AS document, count(*) AS entityCount
        ORDER BY entityCount DESC
      `);

      return new Response(JSON.stringify({
        success: true,
        data: {
          totalNodes: nodeCount.records[0].get('count'),
          totalRelationships: relCount.records[0].get('count'),
          typeBreakdown: typeBreakdown.records.map((r: any) => ({
            type: r.get('type'),
            count: r.get('count'),
          })),
          documentBreakdown: docBreakdown.records.map((r: any) => ({
            document: r.get('document'),
            entityCount: r.get('entityCount'),
          })),
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      await session.close();
    }
  } catch (error: any) {
    logger.error('API', 'Error fetching stats', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
