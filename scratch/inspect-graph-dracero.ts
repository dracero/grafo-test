import { KnowledgeGraphBuilderImpl } from '../src/services/knowledge-graph-builder';
import { ConfigurationManager } from '../src/config';

async function main() {
  const configManager = new ConfigurationManager();
  configManager.load();
  const config = configManager.getConfig();

  const graphBuilder = new KnowledgeGraphBuilderImpl();
  await graphBuilder.connect(config.neo4j);

  const driver = (graphBuilder as any).driver;
  const session = driver.session();

  const userEmail = 'dracero@fi.uba.ar';

  console.log('--- USER ---');
  const userResult = await session.run('MATCH (u:User {email: $userEmail}) RETURN u', { userEmail });
  console.log('User node:', userResult.records.map(r => r.get('u').properties));

  console.log('--- DOCUMENTS ---');
  const docsResult = await session.run('MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d:Document) RETURN labels(d) as labels, d.name as name, d.createdAt as createdAt', { userEmail });
  docsResult.records.forEach(r => console.log(`- Labels: ${r.get('labels')}, Name: ${r.get('name')}, Created: ${r.get('createdAt')}`));

  console.log('--- ONTOLOGY ITEMS ---');
  const ontResult = await session.run('MATCH (o:OntologyItem) RETURN count(o) as count');
  console.log('Total OntologyItem nodes in database:', ontResult.records[0].get('count').toString());

  const userOntResult = await session.run('MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(d:NormativeDocument)<-[:EXTRACTED_FROM]-(o:OntologyItem) RETURN count(o) as count', { userEmail });
  console.log('OntologyItem nodes for this user:', userOntResult.records[0].get('count').toString());

  console.log('--- EVALUATED AGAINST ---');
  const evalResult = await session.run(`
    MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument)-[r:EVALUATED_AGAINST]->(o:OntologyItem)
    RETURN p.name as program, o.id as requirement, r.status as status
  `, { userEmail });
  console.log(`Evaluated relationships for this user: ${evalResult.records.length}`);
  evalResult.records.forEach(r => console.log(`- Program: ${r.get('program')}, Req: ${r.get('requirement')}, Status: ${r.get('status')}`));

  await session.close();
  await graphBuilder.disconnect();
}

main().catch(console.error);
