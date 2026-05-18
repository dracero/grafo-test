/**
 * Script to completely clear the Neo4j database
 * Removes all nodes, relationships, constraints, and indexes
 */

import neo4j from 'neo4j-driver';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function clearDatabase() {
  const driver = neo4j.driver(
    process.env.NEO4J_URI!,
    neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!)
  );

  const session = driver.session();

  try {
    console.log('🔌 Conectando a Neo4j...');
    
    // Verify connection
    await session.run('RETURN 1');
    console.log('✅ Conexión exitosa');

    // Step 1: Delete all relationships
    console.log('\n🗑️  Eliminando todas las relaciones...');
    const relResult = await session.run('MATCH ()-[r]->() DELETE r RETURN count(r) as count');
    console.log(`   Relaciones eliminadas: ${relResult.records[0].get('count').toNumber()}`);

    // Step 2: Delete all nodes
    console.log('\n🗑️  Eliminando todos los nodos...');
    const nodeResult = await session.run('MATCH (n) DELETE n RETURN count(n) as count');
    console.log(`   Nodos eliminados: ${nodeResult.records[0].get('count').toNumber()}`);

    // Step 3: Drop all constraints
    console.log('\n🗑️  Eliminando constraints...');
    const constraints = await session.run('SHOW CONSTRAINTS');
    for (const record of constraints.records) {
      const constraintName = record.get('name');
      try {
        await session.run(`DROP CONSTRAINT ${constraintName} IF EXISTS`);
        console.log(`   ✓ Constraint eliminado: ${constraintName}`);
      } catch (error) {
        console.log(`   ⚠️  No se pudo eliminar constraint: ${constraintName}`);
      }
    }

    // Step 4: Drop all indexes
    console.log('\n🗑️  Eliminando índices...');
    const indexes = await session.run('SHOW INDEXES');
    for (const record of indexes.records) {
      const indexName = record.get('name');
      const indexType = record.get('type');
      
      // Skip built-in indexes
      if (indexType === 'LOOKUP') {
        console.log(`   ⏭️  Saltando índice built-in: ${indexName}`);
        continue;
      }

      try {
        await session.run(`DROP INDEX ${indexName} IF EXISTS`);
        console.log(`   ✓ Índice eliminado: ${indexName}`);
      } catch (error) {
        console.log(`   ⚠️  No se pudo eliminar índice: ${indexName}`);
      }
    }

    // Step 5: Verify database is empty
    console.log('\n🔍 Verificando que la base de datos esté vacía...');
    const verifyNodes = await session.run('MATCH (n) RETURN count(n) as count');
    const verifyRels = await session.run('MATCH ()-[r]->() RETURN count(r) as count');
    
    const nodeCount = verifyNodes.records[0].get('count').toNumber();
    const relCount = verifyRels.records[0].get('count').toNumber();

    if (nodeCount === 0 && relCount === 0) {
      console.log('✅ Base de datos completamente limpia');
      console.log(`   Nodos: ${nodeCount}`);
      console.log(`   Relaciones: ${relCount}`);
    } else {
      console.log('⚠️  Advertencia: La base de datos aún contiene datos');
      console.log(`   Nodos: ${nodeCount}`);
      console.log(`   Relaciones: ${relCount}`);
    }

  } catch (error) {
    console.error('❌ Error al limpiar la base de datos:', error);
    throw error;
  } finally {
    await session.close();
    await driver.close();
    console.log('\n🔌 Conexión cerrada');
  }
}

// Execute
clearDatabase()
  .then(() => {
    console.log('\n✅ Proceso completado exitosamente');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Error fatal:', error);
    process.exit(1);
  });
