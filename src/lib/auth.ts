import crypto from 'crypto';
import { getUserByEmail } from './mongodb';

const SECRET_KEY = process.env.JWT_SECRET || 'antigravity-secret-key-change-me-in-production-123456';

export interface UserSessionPayload {
  email: string;
  name: string;
  role: string;
}

// ── Password Cifrado ────────────────────────────────────────────────────────
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// ── JWT Sign/Verify (HMAC SHA-256) ─────────────────────────────────────────
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString();
}

export function createToken(payload: UserSessionPayload, expiresInSeconds: number = 24 * 60 * 60): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(signatureInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signatureInput}.${signature}`;
}

export function verifyToken(token: string): UserSessionPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const signatureInput = `${header}.${payload}`;
    const expectedSignature = crypto
      .createHmac('sha256', SECRET_KEY)
      .update(signatureInput)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    if (signature !== expectedSignature) return null;

    const decodedPayload = JSON.parse(base64UrlDecode(payload));
    const now = Math.floor(Date.now() / 1000);
    if (decodedPayload.exp && decodedPayload.exp < now) {
      return null; // Expired
    }

    return {
      email: decodedPayload.email,
      name: decodedPayload.name,
      role: decodedPayload.role
    };
  } catch {
    return null;
  }
}

// ── Auth Services ───────────────────────────────────────────────────────────
export async function getSessionUser(token?: string): Promise<UserSessionPayload | null> {
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded) return null;

  const dbUser = await getUserByEmail(decoded.email);
  if (!dbUser || !dbUser.isActive) return null;

  return {
    email: dbUser.email,
    name: dbUser.name,
    role: dbUser.role
  };
}
