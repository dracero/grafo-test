/**
 * GET /api/stats
 * Returns graph statistics.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../lib/services';
import { createLogger } from '../../services/logger';

const logger = createLogger();

export const GET: APIRoute = async ({ locals }) => {
  try {
    const userEmail = locals.user?.email;
    if (!userEmail) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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
      const nodeCount = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d)
        WITH collect(d) AS ownedNodes, u
        OPTIONAL MATCH (u)-[:OWNED_BY]->(doc:Document)
        WITH ownedNodes, collect(doc.name) AS ownedDocs
        MATCH (n)
        WHERE n IN ownedNodes OR (n:Entity AND any(doc IN n.documents WHERE doc IN ownedDocs))
        RETURN count(n) AS count
      `, { userEmail });

      const relCount = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d)
        WITH collect(d) AS ownedNodes, u
        OPTIONAL MATCH (u)-[:OWNED_BY]->(doc:Document)
        WITH ownedNodes, collect(doc.name) AS ownedDocs
        MATCH (n)
        WHERE n IN ownedNodes OR (n:Entity AND any(doc IN n.documents WHERE doc IN ownedDocs))
        WITH collect(n) AS userNodes
        UNWIND userNodes AS a
        MATCH (a)-[r]->(b)
        WHERE b IN userNodes
        RETURN count(r) AS count
      `, { userEmail });

      const typeBreakdown = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d)
        WITH collect(d) AS ownedNodes, u
        OPTIONAL MATCH (u)-[:OWNED_BY]->(doc:Document)
        WITH ownedNodes, collect(doc.name) AS ownedDocs
        MATCH (n)
        WHERE n IN ownedNodes OR (n:Entity AND any(doc IN n.documents WHERE doc IN ownedDocs))
        WITH labels(n) AS lbls, COALESCE(n.type, labels(n)[0]) AS type
        RETURN type, count(*) AS count
        ORDER BY count DESC
      `, { userEmail });

      const docBreakdown = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(doc:Document)
        WITH collect(doc.name) AS ownedDocs
        MATCH (n:Entity)
        WHERE any(doc IN n.documents WHERE doc IN ownedDocs)
        UNWIND n.documents AS doc
        WITH doc, ownedDocs
        WHERE doc IN ownedDocs
        RETURN doc AS document, count(*) AS entityCount
        ORDER BY entityCount DESC
      `, { userEmail });

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
