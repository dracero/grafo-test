import { MongoClient, Db } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'rubricai_auth';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectToMongoDB(): Promise<Db> {
  if (db) return db;
  
  if (!client) {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 3000 // Fast connection timeout
    });
    await client.connect();
  }
  
  db = client.db(MONGODB_DB);
  
  // Ensure unique index on email
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  
  return db;
}

export interface UserDoc {
  email: string;
  name: string;
  provider: 'local' | 'google' | 'microsoft';
  passwordHash?: string;
  role: 'admin' | 'rubricador' | 'pending';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export async function getUserByEmail(email: string): Promise<UserDoc | null> {
  const database = await connectToMongoDB();
  const doc = await database.collection<UserDoc>('users').findOne({ email: email.toLowerCase() });
  return doc;
}

export async function createUser(user: Omit<UserDoc, 'createdAt' | 'updatedAt'>): Promise<void> {
  const database = await connectToMongoDB();
  const now = new Date();
  await database.collection<UserDoc>('users').insertOne({
    ...user,
    email: user.email.toLowerCase(),
    createdAt: now,
    updatedAt: now
  });
}

export async function upsertOAuthUser(email: string, name: string, provider: 'google' | 'microsoft'): Promise<UserDoc> {
  const database = await connectToMongoDB();
  const lowerEmail = email.toLowerCase();
  
  const hasUsers = await hasAnyUser();
  const defaultRole = hasUsers ? 'pending' : 'admin';
  const defaultActive = !hasUsers; // Active if admin, inactive/pending otherwise

  await database.collection<UserDoc>('users').updateOne(
    { email: lowerEmail },
    {
      $set: { name, provider, updatedAt: new Date() },
      $setOnInsert: {
        email: lowerEmail,
        role: defaultRole,
        isActive: defaultActive,
        createdAt: new Date()
      }
    },
    { upsert: true }
  );

  const doc = await getUserByEmail(lowerEmail);
  return doc!;
}

export async function listUsers(): Promise<UserDoc[]> {
  const database = await connectToMongoDB();
  const docs = await database.collection<UserDoc>('users')
    .find({}, { projection: { passwordHash: 0 } })
    .sort({ email: 1 })
    .toArray();
  return docs;
}

export async function updateUser(email: string, updates: Partial<UserDoc>): Promise<void> {
  const database = await connectToMongoDB();
  await database.collection<UserDoc>('users').updateOne(
    { email: email.toLowerCase() },
    {
      $set: {
        ...updates,
        updatedAt: new Date()
      }
    }
  );
}

export async function deleteUser(email: string): Promise<boolean> {
  const database = await connectToMongoDB();
  const res = await database.collection<UserDoc>('users').deleteOne({ email: email.toLowerCase() });
  return (res.deletedCount ?? 0) > 0;
}

export async function hasAnyUser(): Promise<boolean> {
  const database = await connectToMongoDB();
  const count = await database.collection('users').countDocuments();
  return count > 0;
}
