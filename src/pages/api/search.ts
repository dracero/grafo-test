/**
 * POST /api/search
 * Vector similarity search. Body: { query: string, limit?: number }
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../lib/services';
import { createLogger } from '../../services/logger';

const logger = createLogger();

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const userEmail = locals.user?.email;
    if (!userEmail) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { genkitEngine, graphBuilder } = await getServices();
    const body = await request.json();
    const { query, limit = 10 } = body;

    if (!query) {
      return new Response(JSON.stringify({ success: false, error: 'Query is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const neo4jDriver = (graphBuilder as any).driver;
    if (!neo4jDriver) {
      throw new Error('Neo4j connection is not available');
    }
    const session = neo4jDriver.session({ defaultAccessMode: 'READ' });
    let ownedDocs: string[] = [];
    try {
      const result = await session.run(
        'MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d:Document) RETURN d.name AS name',
        { userEmail }
      );
      ownedDocs = result.records.map((r: any) => r.get('name'));
    } finally {
      await session.close();
    }

    const results = await genkitEngine.retrieve(query, limit);
    const filteredResults = results.filter(r => 
      r.sourceDocuments.some(doc => ownedDocs.includes(doc))
    );

    return new Response(JSON.stringify({ success: true, data: filteredResults }), {
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
