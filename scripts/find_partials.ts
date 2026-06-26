import dotenv from 'dotenv';
import path from 'path';
import { KnowledgeGraphBuilderImpl } from '../src/services/knowledge-graph-builder';

// Load env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const neo4jConfig = {
    uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    username: process.env.NEO4J_USERNAME || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'password',
    database: process.env.NEO4J_DATABASE || 'neo4j'
  };

  const graphBuilder = new KnowledgeGraphBuilderImpl();
  await graphBuilder.connect(neo4jConfig);

  try {
    const session = graphBuilder['driver'].session({ database: neo4jConfig.database });

    console.log('\n--- Checking ALL EVALUATED_AGAINST relationships in Neo4j ---');
    const result = await session.run(`
      MATCH (src)-[r:EVALUATED_AGAINST]->(dst)
      RETURN labels(src) as srcLabels, src.name as srcName, r.status as status, labels(dst) as dstLabels, dst.id as dstId
    `);
    
    const rels = result.records.map(r => ({
      src: { labels: r.get('srcLabels'), name: r.get('srcName') },
      status: r.get('status'),
      dst: { labels: r.get('dstLabels'), id: r.get('dstId') }
    }));
    console.log(`Total relationships found: ${rels.length}`);
    console.log(rels);

  } catch (err: any) {
    console.error('Error during test:', err);
  } finally {
    await graphBuilder.disconnect();
  }
}

main().catch(console.error);
