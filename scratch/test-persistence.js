const { MongoClient } = require('mongodb');
const neo4j = require('neo4j-driver');

async function testMongo(action) {
  const uri = 'mongodb://localhost:27017';
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('rubricai_auth');
    const collection = db.collection('test_persistence');
    
    if (action === 'write') {
      await collection.deleteMany({});
      const result = await collection.insertOne({ testKey: 'Hello MongoDB Persistence!', timestamp: Date.now() });
      console.log('✔ MongoDB: Wrote test document. ID:', result.insertedId);
    } else if (action === 'read') {
      const doc = await collection.findOne({ testKey: 'Hello MongoDB Persistence!' });
      if (doc) {
        console.log('✔ MongoDB: Found test document:', doc);
      } else {
        console.error('❌ MongoDB: Test document NOT found!');
      }
    }
  } catch (err) {
    console.error('❌ MongoDB Error:', err);
  } finally {
    await client.close();
  }
}

async function testNeo4j(action) {
  const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('neo4j', 'password'));
  const session = driver.session();
  try {
    if (action === 'write') {
      await session.run('MATCH (n:TestPersistence) DETACH DELETE n');
      const result = await session.run(
        'CREATE (n:TestPersistence {message: $msg, timestamp: $ts}) RETURN n',
        { msg: 'Hello Neo4j Persistence!', ts: Date.now() }
      );
      console.log('✔ Neo4j: Created test node.');
    } else if (action === 'read') {
      const result = await session.run('MATCH (n:TestPersistence) RETURN n');
      if (result.records.length > 0) {
        const node = result.records[0].get('n');
        console.log('✔ Neo4j: Found test node:', node.properties);
      } else {
        console.error('❌ Neo4j: Test node NOT found!');
      }
    }
  } catch (err) {
    console.error('❌ Neo4j Error:', err);
  } finally {
    await session.close();
    await driver.close();
  }
}

const action = process.argv[2];
if (action !== 'write' && action !== 'read') {
  console.log('Usage: node test-persistence.js [write|read]');
  process.exit(1);
}

async function main() {
  await testMongo(action);
  await testNeo4j(action);
}

main();
