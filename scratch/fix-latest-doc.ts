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

  console.log('Detaching and deleting ProgramDocument "2025_200237_gl.pdf" to clean up...');
  
  await session.run(`
    MATCH (p:ProgramDocument {name: '2025_200237_gl.pdf'})
    DETACH DELETE p
  `);

  console.log('Setting 2025_200230_gl.pdf createdAt to current time...');
  await session.run(`
    MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument {name: '2025_200230_gl.pdf'})
    SET p.createdAt = datetime()
    RETURN p.name, p.createdAt
  `, { userEmail });

  console.log('Done!');

  await session.close();
  await graphBuilder.disconnect();
}

main().catch(console.error);
