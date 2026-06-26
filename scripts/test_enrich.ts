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

    console.log('\n--- Checking all EVALUATED_AGAINST relationships ---');
    const result = await session.run(`
      MATCH (p:ProgramDocument)-[r:EVALUATED_AGAINST]->(o)
      RETURN p.name as program, r.status as status, count(r) as count
    `);
    console.log(result.records.map(r => ({
      program: r.get('program'),
      status: r.get('status'),
      count: r.get('count').toString()
    })));

    console.log('\n--- Checking who owns the documents ---');
    const ownership = await session.run(`
      MATCH (u:User)-[r:OWNED_BY]->(d:Document)
      RETURN u.email as email, labels(d) as labels, d.name as name
    `);
    console.log(ownership.records.map(r => ({
      email: r.get('email'),
      labels: r.get('labels'),
      name: r.get('name')
    })));

  } catch (err: any) {
    console.error('Error during test:', err);
  } finally {
    await graphBuilder.disconnect();
  }
}

main().catch(console.error);
