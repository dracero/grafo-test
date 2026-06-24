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
  const programName = '2025_200230_gl.pdf';
  const normativeName = 'rubrica_multiagente_Anuncio GL.pdf';

  console.log(`Linking "${programName}" and "${normativeName}" to "${userEmail}"...`);

  await session.run(`
    MATCH (u:User {email: $userEmail})
    MATCH (p:ProgramDocument {name: $programName})
    MATCH (n:NormativeDocument {name: $normativeName})
    MERGE (u)-[:OWNED_BY]->(p)
    MERGE (u)-[:OWNED_BY]->(n)
    SET p.createdAt = datetime()
    RETURN p.name, u.email
  `, { userEmail, programName, normativeName });

  console.log('Successfully linked and updated timestamp.');

  await session.close();
  await graphBuilder.disconnect();
}

main().catch(console.error);
