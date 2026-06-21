const { execSync } = require('child_process');
const net = require('net');

function checkPort(port) {
  return new Promise((resolve) => {
    const conn = net.connect(port, 'localhost', () => {
      conn.end();
      resolve(true); // Port is listening
    });
    conn.on('error', () => {
      resolve(false); // Port is not listening
    });
  });
}

function runCommand(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim();
  } catch (err) {
    return '';
  }
}

async function startDatabases() {
  console.log('🤖 Checking local databases...');

  // 1. Check MongoDB (Port 27017)
  const mongoRunning = await checkPort(27017);
  if (mongoRunning) {
    console.log('✔ MongoDB is already running on port 27017.');
  } else {
    console.log('⏳ MongoDB is not running. Starting via Docker (mongo:4.4)...');
    const containerExists = runCommand('docker ps -a --filter name=^/mongodb-local$ --format "{{.Names}}"');
    if (containerExists === 'mongodb-local') {
      const inspectVolume = runCommand('docker inspect --format "{{ range .Mounts }}{{ .Name }} {{ end }}" mongodb-local');
      if (inspectVolume.includes('mongodb-data')) {
        console.log('   Starting existing mongodb-local container with persistent volume...');
        runCommand('docker start mongodb-local');
      } else {
        console.log('   Removing existing mongodb-local container without persistent volume to enable persistence...');
        runCommand('docker rm -f mongodb-local');
        runCommand('docker run -d --name mongodb-local -v mongodb-data:/data/db -p 27017:27017 mongo:4.4');
      }
    } else {
      console.log('   Creating and starting new container mongodb-local using mongo:4.4 with persistent volume...');
      runCommand('docker run -d --name mongodb-local -v mongodb-data:/data/db -p 27017:27017 mongo:4.4');
    }
    
    // Wait for port to open
    for (let i = 0; i < 20; i++) {
      if (await checkPort(27017)) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (await checkPort(27017)) {
      console.log('✔ MongoDB started successfully.');
    } else {
      console.warn('⚠ MongoDB container started but port 27017 is not responding yet.');
    }
  }

  // 2. Check Neo4j (Port 7687)
  const neo4jRunning = await checkPort(7687);
  if (neo4jRunning) {
    console.log('✔ Neo4j is already running on port 7687.');
  } else {
    console.log('⏳ Neo4j is not running. Starting via Docker...');
    const containerExists = runCommand('docker ps -a --filter name=^/neo4j-local$ --format "{{.Names}}"');
    if (containerExists === 'neo4j-local') {
      const inspectVolume = runCommand('docker inspect --format "{{ range .Mounts }}{{ .Name }} {{ end }}" neo4j-local');
      if (inspectVolume.includes('neo4j-data')) {
        console.log('   Container neo4j-local exists. Starting it...');
        runCommand('docker start neo4j-local');
      } else {
        console.log('   Removing existing neo4j-local container without persistent volume to enable persistence...');
        runCommand('docker rm -f neo4j-local');
        runCommand('docker run -d --name neo4j-local -v neo4j-data:/data -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/password -e NEO4J_PLUGINS=\'["apoc"]\' neo4j:5.20.0-community');
      }
    } else {
      console.log('   Creating and starting new container neo4j-local with persistent volume...');
      runCommand('docker run -d --name neo4j-local -v neo4j-data:/data -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/password -e NEO4J_PLUGINS=\'["apoc"]\' neo4j:5.20.0-community');
    }
    // Wait for port to open
    for (let i = 0; i < 20; i++) {
      if (await checkPort(7687)) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (await checkPort(7687)) {
      console.log('✔ Neo4j started successfully.');
    } else {
      console.warn('⚠ Neo4j container started but port 7687 is not responding yet.');
    }
  }

  console.log('✔ Database check completed.\n');
}

startDatabases().catch((err) => {
  console.error('Error checking/starting databases:', err);
});
