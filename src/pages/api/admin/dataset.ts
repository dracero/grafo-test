import type { APIRoute } from 'astro';
import { getUserByEmail, connectToMongoDB } from '../../../lib/mongodb';
import { ObjectId } from 'mongodb';

// Ensure user is admin helper
async function checkAdmin(locals: any): Promise<boolean> {
  const userEmail = locals.user?.email;
  if (!userEmail) return false;
  const dbUser = await getUserByEmail(userEmail);
  return dbUser?.role === 'admin';
}

/**
 * GET /api/admin/dataset?agentName=ComplianceValidatorAgent
 * Lists curated examples for the specified agent.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    if (!(await checkAdmin(locals))) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 403 });
    }

    const agentName = url.searchParams.get('agentName');
    if (!agentName) {
      return new Response(JSON.stringify({ success: false, error: 'Missing agentName parameter' }), { status: 400 });
    }

    const db = await connectToMongoDB();
    const collection = db.collection('OptimizationDataset');
    const examples = await collection.find({ agentName }).sort({ curatedAt: -1 }).toArray();

    return new Response(JSON.stringify({ success: true, data: examples }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
};

/**
 * POST /api/admin/dataset
 * Saves or updates a curated training example in MongoDB.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!(await checkAdmin(locals))) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 403 });
    }

    const body = await request.json();
    const { id, agentName, inputs, expectedOutput, sourceRunId } = body;

    if (!agentName || !inputs || !expectedOutput) {
      return new Response(JSON.stringify({ success: false, error: 'Missing required fields: agentName, inputs, expectedOutput' }), { status: 400 });
    }

    const db = await connectToMongoDB();
    const collection = db.collection('OptimizationDataset');

    const now = new Date();
    let result;

    if (id) {
      // Update existing example
      result = await collection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            inputs,
            expectedOutput,
            sourceRunId: sourceRunId || null,
            updatedAt: now,
          }
        }
      );
    } else {
      // Create new example. Prevent duplicate curations of the same Langsmith run
      if (sourceRunId) {
        const existing = await collection.findOne({ agentName, sourceRunId });
        if (existing) {
          return new Response(JSON.stringify({ success: false, error: 'This run has already been curated into the dataset' }), { status: 409 });
        }
      }

      result = await collection.insertOne({
        agentName,
        inputs,
        expectedOutput,
        sourceRunId: sourceRunId || null,
        curatedAt: now,
        updatedAt: now,
      });
    }

    return new Response(JSON.stringify({ success: true, data: result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
};

/**
 * DELETE /api/admin/dataset
 * Deletes a curated training example from MongoDB.
 */
export const DELETE: APIRoute = async ({ url, locals }) => {
  try {
    if (!(await checkAdmin(locals))) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 403 });
    }

    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ success: false, error: 'Missing id parameter' }), { status: 400 });
    }

    const db = await connectToMongoDB();
    const collection = db.collection('OptimizationDataset');
    const result = await collection.deleteOne({ _id: new ObjectId(id) });

    return new Response(JSON.stringify({ success: true, deletedCount: result.deletedCount }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
};
