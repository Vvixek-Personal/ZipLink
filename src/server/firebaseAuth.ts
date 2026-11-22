import fs from 'node:fs';
import path from 'node:path';
import { getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { ZipLinkAuthUser } from '../shared/types.ts';

export class FirebaseAuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = 'FirebaseAuthError';
    this.statusCode = statusCode;
  }
}

export interface FirebaseTokenVerifier {
  isConfigured(): boolean;
  readonly projectId: string | null;
  verifyIdToken(idToken: string): Promise<ZipLinkAuthUser>;
}

function readConfiguredFirebaseProjectId(): string | null {
  const envProjectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  if (envProjectId && envProjectId !== 'remixed-project-id') {
    return envProjectId;
  }

  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projectId?: unknown };
    if (
      typeof raw.projectId === 'string' &&
      raw.projectId.trim().length > 0 &&
      raw.projectId !== 'remixed-project-id'
    ) {
      return raw.projectId.trim();
    }
  } catch {
    return null;
  }
  return null;
}

const ADMIN_APP_NAME = 'ziplink-id-verifier';

export class RealFirebaseTokenVerifier implements FirebaseTokenVerifier {
  readonly projectId: string | null;
  private adminApp: App | null = null;

  constructor(explicitProjectId?: string | null) {
    this.projectId =
      explicitProjectId === undefined ? readConfiguredFirebaseProjectId() : explicitProjectId;
  }

  isConfigured(): boolean {
    return Boolean(this.projectId);
  }

  private getOrCreateAdminApp(): App {
    if (!this.projectId) {
      throw new FirebaseAuthError(
        'Firebase Authentication is not configured on this server.',
        503,
      );
    }
    if (this.adminApp) return this.adminApp;

    const existing = getApps().find((a) => a.name === ADMIN_APP_NAME);
    this.adminApp = existing ?? initializeApp({ projectId: this.projectId }, ADMIN_APP_NAME);
    return this.adminApp;
  }

  async verifyIdToken(idToken: string): Promise<ZipLinkAuthUser> {
    if (!this.isConfigured()) {
      throw new FirebaseAuthError(
        'Firebase Authentication is not configured on this server.',
        503,
      );
    }

    const trimmed = idToken.trim();
    if (!trimmed || trimmed.length > 8192) {
      throw new FirebaseAuthError('Invalid Firebase ID token.', 401);
    }

    try {
      const app = this.getOrCreateAdminApp();
      const decoded = await getAuth(app).verifyIdToken(trimmed);
      if (!decoded.uid || typeof decoded.uid !== 'string') {
        throw new FirebaseAuthError('Firebase token missing user identifier.', 401);
      }
      return {
        uid: decoded.uid,
        email: typeof decoded.email === 'string' ? decoded.email : null,
        emailVerified: Boolean(decoded.email_verified),
        name: typeof decoded.name === 'string' ? decoded.name : null,
        picture: typeof decoded.picture === 'string' ? decoded.picture : null,
      };
    } catch (err) {
      if (err instanceof FirebaseAuthError) throw err;
      throw new FirebaseAuthError(
        'Invalid or expired Google sign-in session. Please sign in again.',
        401,
      );
    }
  }
}

export function getAdminAppSafely(): App | null {
  return getApps().length > 0 ? getApp() : null;
}
