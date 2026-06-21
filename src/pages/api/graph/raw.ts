/**
 * GET /api/graph/raw
 * Returns raw Neo4j graph data (all nodes and relationships)
 * directly via Cypher for maximum fidelity.
 */
import type { APIRoute } from 'astro';
import { getServices } from '../../../lib/services';

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
      // Get nodes that are part of the ontology or comparison for the current user
      const nodesResult = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d:Document)
        OPTIONAL MATCH (d)-[:EXTRACTED_FROM|COMPARED_TO|EVALUATED_AGAINST]-(x)
        WITH d, x
        UNWIND [d, x] AS n
        WITH DISTINCT n
        WHERE n IS NOT NULL AND (n:NormativeDocument OR n:ProgramDocument OR n:OntologyItem)
        RETURN n, labels(n) AS labels, elementId(n) AS elementId
      `, { userEmail });

      // Get relationships between those specific nodes for the current user
      const relsResult = await session.run(`
        MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d:Document)
        OPTIONAL MATCH (d)-[:EXTRACTED_FROM|COMPARED_TO|EVALUATED_AGAINST]-(x)
        WITH collect(DISTINCT d) + collect(DISTINCT x) AS userNodes
        UNWIND userNodes AS a
        MATCH (a)-[r]->(b)
        WHERE b IN userNodes
          AND (a:NormativeDocument OR a:ProgramDocument OR a:OntologyItem)
          AND (b:NormativeDocument OR b:ProgramDocument OR b:OntologyItem)
        RETURN type(r) AS type, 
               properties(r) AS props,
               elementId(a) AS sourceId, 
               elementId(b) AS targetId,
               a.name AS sourceName,
               b.name AS targetName
      `, { userEmail });

      const nodes = nodesResult.records.map((record: any) => {
        const node = record.get('n');
        const props = node.properties;
        return {
          id: props.name || props.id || record.get('elementId'),
          label: props.name || props.title || 'Unknown',
          type: props.type || record.get('labels')[0] || 'OTHER',
          properties: props,
          elementId: record.get('elementId'),
        };
      });

      const edges = relsResult.records.map((record: any, index: number) => ({
        id: `edge_${index}`,
        source: record.get('sourceName') || record.get('sourceId'),
        target: record.get('targetName') || record.get('targetId'),
        label: record.get('type'),
        properties: record.get('props'),
      }));

      return new Response(JSON.stringify({
        success: true,
        data: { nodes, edges },
        stats: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      await session.close();
    }
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
