import { MongoClient } from 'mongodb';
import neo4j from 'neo4j-driver';

async function main() {
  // MongoDB
  const mongoClient = new MongoClient('mongodb://localhost:27017');
  try {
    await mongoClient.connect();
    const db = mongoClient.db('rubricai_auth');
    const users = await db.collection('users').find({}).toArray();
    console.log('MongoDB Users:');
    users.forEach(u => console.log(`- Email: ${u.email}, Active: ${u.isActive}, Role: ${u.role}`));
    
    const sessions = await db.collection('sessions').find({}).toArray();
    console.log('MongoDB Sessions:', sessions.length);
  } catch (err) {
    console.error('Mongo error:', err);
  } finally {
    await mongoClient.close();
  }

  // Neo4j
  const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('neo4j', 'password'));
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (u:User)-[:OWNED_BY]->(p:ProgramDocument)-[:COMPARED_TO]->(n:NormativeDocument)
      RETURN u.email AS email, p.name AS programName, n.name AS normativeName, p.total AS total, p.covered AS covered, p.partial AS partial, p.missing AS missing
    `);
    console.log('\nNeo4j Comparisons:');
    result.records.forEach(r => {
      console.log(`- User: ${r.get('email')}`);
      console.log(`  Program: ${r.get('programName')}`);
      console.log(`  Normative: ${r.get('normativeName')}`);
      console.log(`  Summary: Total ${r.get('total')}, Covered ${r.get('covered')}, Partial ${r.get('partial')}, Missing ${r.get('missing')}`);
    });
  } catch (err) {
    console.error('Neo4j error:', err);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
