import { createServerApp } from '../src/server';
import { Request, Response } from 'express';

let appPromise: ReturnType<typeof createServerApp>;

export default async function handler(req: Request, res: Response) {
  if (!appPromise) {
    appPromise = createServerApp();
  }
  
  try {
    const app = await appPromise;
    return app(req, res);
  } catch (err: any) {
    console.error('Failed to initialize server for Vercel:', err);
    res.status(500).json({ success: false, error: 'Server initialization failed' });
  }
}
