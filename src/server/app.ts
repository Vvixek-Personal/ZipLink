import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { loadConfig, type ZipLinkConfig } from './config.ts';
import {
  FirebaseAuthError,
  RealFirebaseTokenVerifier,
  type FirebaseTokenVerifier,
} from './firebaseAuth.ts';
import { encryptSecret } from './gitHash.ts';
import {
  GitHubApiError,
  GitHubRemoteMovedError,
  RealGitHubClient,
  type GitHubClient,
} from './githubClient.ts';
import { createStorageProvider, isSafeStorageId, type StorageProvider } from './storage.ts';
import {
  toWorkspaceSummary,
  WorkspaceService,
  WorkspaceServiceError,
} from './workspaceService.ts';
import { safelyExtractZipToTempDir, ZipExtractionError } from './zipExtractor.ts';
import { buildContextMarkdown, buildManifestJson } from '../shared/contextBuilder.ts';
import {
  detectSensitiveFilenames,
  isValidExpiryOption,
  resolveExpiryTimestamp,
  sanitizeArchiveFilename,
  sanitizeContentDispositionFilename,
  formatBytes,
} from '../shared/zipSecurity.ts';
import type {
  ExpiryOption,
  GitHubConnectionRecord,
  PublicShareMetadata,
  ShareRecord,
  UploadSuccessPayload,
  ZipLinkAuthUser,
} from '../shared/types.ts';

const GITHUB_STATE_COOKIE = 'ziplink_gh_oauth_state';
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufA, bufB);
}

function stripPrivateShareFields(record: ShareRecord): PublicShareMetadata {
  const { deleteTokenHash: _omitted, ...publicMeta } = record;
  return publicMeta;
}

function resolveRequestOrigin(req: Request): string {
  const protoHeader = req.get('x-forwarded-proto');
  const proto = protoHeader ? protoHeader.split(',')[0].trim() : req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:3000';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function resolveBaseUrl(req: Request, config: ZipLinkConfig): string {
  return config.appUrl || resolveRequestOrigin(req);
}

function isHttpsRequest(req: Request): boolean {
  const protoHeader = req.get('x-forwarded-proto');
  const proto = protoHeader ? protoHeader.split(',')[0].trim().toLowerCase() : req.protocol;
  return proto === 'https';
}

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader) return map;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      map.set(key, decodeURIComponent(val));
    } catch {
      map.set(key, val);
    }
  }
  return map;
}

function formatStateCookie(
  name: string,
  value: string,
  opts: { maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${opts.maxAgeSeconds}`,
    'SameSite=Lax',
  ];
  if (opts.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function createBoundOAuthState(
  nonce: string,
  uid: string,
  nowMs: number,
  keyMaterial: Buffer,
): string {
  const uidHash = sha256Hex(uid).slice(0, 32);
  const ts = Math.floor(nowMs / 1000).toString(36);
  const payload = `${nonce}.${uidHash}.${ts}`;
  const sig = crypto.createHmac('sha256', keyMaterial).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseAndVerifyBoundOAuthState(
  rawState: string,
  nowMs: number,
  keyMaterial: Buffer,
): { nonce: string; uidHash: string } | null {
  const parts = rawState.split('.');
  if (parts.length !== 4) return null;
  const [nonce, uidHash, tsStr, sig] = parts;
  if (!nonce || !uidHash || !tsStr || !sig || !isSafeStorageId(nonce)) return null;
  const payload = `${nonce}.${uidHash}.${tsStr}`;
  const expected = crypto.createHmac('sha256', keyMaterial).update(payload).digest('base64url');
  if (!timingSafeHexEqual(sig, expected)) return null;
  const issuedSec = Number.parseInt(tsStr, 36);
  const nowSec = Math.floor(nowMs / 1000);
  if (!Number.isFinite(issuedSec) || nowSec - issuedSec < -60 || nowSec - issuedSec > 900) {
    return null;
  }
  return { nonce, uidHash };
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface CreateAppOptions {
  config?: Partial<ZipLinkConfig>;
  storage?: StorageProvider;
  githubClient?: GitHubClient;
  firebaseVerifier?: FirebaseTokenVerifier;
  disableRateLimit?: boolean;
  now?: () => number;
}

export async function createZipLinkApp(options: CreateAppOptions = {}): Promise<{
  app: Express;
  config: ZipLinkConfig;
  storage: StorageProvider;
}> {
  const config = loadConfig(options.config);
  const storage = options.storage ?? createStorageProvider(config);
  await storage.init();

  const nowFn = options.now ?? (() => Date.now());
  const firebaseVerifier = options.firebaseVerifier ?? new RealFirebaseTokenVerifier();
  const githubClient =
    options.githubClient ??
    new RealGitHubClient({
      apiBaseUrl: config.githubApiBaseUrl,
      authBaseUrl: config.githubAuthBaseUrl,
      clientId: config.githubClientId,
      clientSecret: config.githubClientSecret,
    });

  const workspaceService = new WorkspaceService({
    config,
    storage,
    githubClient,
    now: nowFn,
  });

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Global security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Noindex & no-store headers on unlisted share, account, GitHub, workspace, and stage routes
  app.use(
    [
      '/api/auth',
      '/api/account',
      '/api/shares',
      '/api/github',
      '/api/workspaces',
      '/api/zip-to-github',
      '/s',
      '/delete',
      '/workspaces',
      '/zip-to-github',
    ],
    (_req, res, next) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );

  app.use(express.json({ limit: '1mb' }));

  const uploadTempRoot = path.join(os.tmpdir(), 'ziplink-uploads');
  await fsp.mkdir(uploadTempRoot, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        cb(null, uploadTempRoot);
      },
      filename: (_req, _file, cb) => {
        cb(null, `${crypto.randomUUID()}.zip`);
      },
    }),
    limits: {
      fileSize: config.maxCompressedBytes,
      files: 1,
      fields: 5,
    },
  });

  const binaryUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.min(config.maxCompressedBytes, 25 * 1024 * 1024),
      files: 1,
      fields: 5,
    },
  });

  const uploadLimiter = options.disableRateLimit
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: config.uploadRateLimitWindowMs,
        max: config.uploadRateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'Upload rate limit reached. Please wait a few minutes before uploading again.',
        },
      });

  const readDeleteLimiter = options.disableRateLimit
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: 60 * 1000,
        max: 240,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'Too many requests. Please slow down and try again shortly.',
        },
      });

  function extractBearerToken(req: Request): string | null {
    const authHeader = req.get('authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return null;
    }
    const token = authHeader.slice(7).trim();
    return token.length > 0 ? token : null;
  }

  function verifyMutationCsrf(req: Request, res: Response): boolean {
    if (req.get('x-ziplink-client') === '1') {
      return true;
    }
    const origin = req.get('origin');
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        const expectedHost = req.get('x-forwarded-host') || req.get('host');
        if (expectedHost && originHost === expectedHost) {
          return true;
        }
      } catch {
        // invalid origin
      }
    }
    res.status(403).json({
      error: 'Request rejected by CSRF protection. Refresh the page and try again.',
    });
    return false;
  }

  async function requireVerifiedUser(
    req: Request,
    res: Response,
    requireCsrfForMutation = true,
  ): Promise<ZipLinkAuthUser | null> {
    if (requireCsrfForMutation && req.method !== 'GET' && req.method !== 'HEAD') {
      if (!verifyMutationCsrf(req, res)) return null;
    }
    if (!firebaseVerifier.isConfigured()) {
      res.status(503).json({
        error: 'Firebase Authentication is not configured on this server.',
      });
      return null;
    }
    const idToken = extractBearerToken(req);
    if (!idToken) {
      res.status(401).json({
        error: 'Google sign-in is required for private workspaces and GitHub actions.',
      });
      return null;
    }
    try {
      const user = await firebaseVerifier.verifyIdToken(idToken);
      if (!user.emailVerified) {
        res.status(403).json({
          error: 'A verified Google account email is required to access private ZipLink workspaces.',
        });
        return null;
      }
      return user;
    } catch (err) {
      const status = err instanceof FirebaseAuthError ? err.statusCode : 401;
      const msg =
        err instanceof Error ? err.message : 'Invalid or expired Google sign-in token.';
      res.status(status).json({ error: msg });
      return null;
    }
  }

  async function requireGitHubConnection(
    req: Request,
    res: Response,
    requireCsrfForMutation = true,
  ): Promise<{ user: ZipLinkAuthUser; connection: GitHubConnectionRecord } | null> {
    const user = await requireVerifiedUser(req, res, requireCsrfForMutation);
    if (!user) return null;
    const connection = await storage.getGitHubConnection(user.uid);
    if (!connection) {
      res.status(403).json({
        error: 'GitHub is not connected for this account. Click "Connect GitHub" to authorize repositories.',
        githubConnectionRequired: true,
      });
      return null;
    }
    return { user, connection };
  }

  function handleServiceError(err: unknown, res: Response, next: NextFunction): void {
    if (err instanceof GitHubRemoteMovedError) {
      res.status(409).json({
        error: err.message,
        remoteMoved: true,
        latestCommitSha: err.latestCommitSha,
      });
      return;
    }
    if (
      err instanceof WorkspaceServiceError ||
      err instanceof GitHubApiError ||
      err instanceof ZipExtractionError ||
      err instanceof FirebaseAuthError
    ) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      storageDriver: storage.driverName,
      firebaseConfigured: firebaseVerifier.isConfigured(),
    });
  });

  app.get('/api/limits', (_req, res) => {
    res.json({
      maxCompressedBytes: config.maxCompressedBytes,
      maxExtractedBytes: config.maxExtractedBytes,
      maxEntryCount: config.maxEntryCount,
      maxContextMdBytes: config.maxContextMdBytes,
      maxTextPreviewBytes: config.maxTextPreviewBytes,
      storageDriver: storage.driverName,
    });
  });

  // ==========================================================================
  // ZipLink Account Authentication (Firebase Google Sign-In) & Data Deletion
  // ==========================================================================

  app.get('/api/auth/status', readDeleteLimiter, async (req, res) => {
    const firebaseConfigured = firebaseVerifier.isConfigured();
    if (!firebaseConfigured) {
      res.json({ firebaseConfigured: false, authenticated: false, user: null });
      return;
    }

    const idToken = extractBearerToken(req);
    if (!idToken) {
      res.json({ firebaseConfigured: true, authenticated: false, user: null });
      return;
    }

    try {
      const user = await firebaseVerifier.verifyIdToken(idToken);
      res.json({
        firebaseConfigured: true,
        authenticated: Boolean(user.emailVerified),
        user: user.emailVerified ? user : null,
      });
    } catch {
      res.json({ firebaseConfigured: true, authenticated: false, user: null });
    }
  });

  app.delete('/api/account/data', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, true);
      if (!user) return;
      if (req.body?.confirmDelete !== true) {
        res.status(400).json({
          error: 'Explicit confirmation is required to permanently delete your ZipLink account data.',
        });
        return;
      }
      const counts = await storage.deleteAllUserData(user.uid);
      res.json({
        deleted: true,
        ...counts,
      });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  // ==========================================================================
  // GitHub App OAuth & Repository Authorization Routes (Per Verified User)
  // ==========================================================================

  app.get('/api/github/status', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, false);
      if (!user) return;
      const connection = await storage.getGitHubConnection(user.uid);
      const status = workspaceService.getConfigStatus(resolveRequestOrigin(req), connection);
      res.json(status);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.get('/api/github/oauth/url', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, false);
      if (!user) return;

      const currentOrigin = resolveRequestOrigin(req);
      const status = workspaceService.getConfigStatus(currentOrigin, null);
      if (!status.configured) {
        res.status(503).json({
          error: `GitHub App OAuth is not configured on this server. Missing: ${status.missingVars.join(', ')}.`,
          status,
        });
        return;
      }

      const nowMs = nowFn();
      const nonce = crypto.randomBytes(18).toString('base64url');
      await storage.savePendingOAuthState({
        nonce,
        uid: user.uid,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + OAUTH_STATE_TTL_MS,
      });

      const state = createBoundOAuthState(nonce, user.uid, nowMs, config.sessionKey);
      const secure = isHttpsRequest(req);
      res.setHeader(
        'Set-Cookie',
        formatStateCookie(GITHUB_STATE_COOKIE, state, { maxAgeSeconds: 900, secure }),
      );

      const callbackUrl = status.callbackUrls.current;
      const params = new URLSearchParams({
        client_id: config.githubClientId,
        redirect_uri: callbackUrl,
        state,
        allow_signup: 'true',
      });

      res.json({
        authorizeUrl: `${config.githubAuthBaseUrl}/login/oauth/authorize?${params.toString()}`,
        installUrl: status.installUrl,
        callbackUrl,
      });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  const handleGitHubCallback = async (req: Request, res: Response) => {
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const errorDesc =
      typeof req.query.error_description === 'string' ? req.query.error_description : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';

    const nonceHtml = crypto.randomBytes(16).toString('base64url');
    const sendPopupResponse = (status: number, ok: boolean, message: string, login = '') => {
      const payloadJson = JSON.stringify({
        type: ok ? 'ZIPLINK_GITHUB_AUTH_SUCCESS' : 'ZIPLINK_GITHUB_AUTH_ERROR',
        login,
        error: ok ? undefined : message,
      });
      res.status(status);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonceHtml}'; style-src 'unsafe-inline'`,
      );
      res.send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ZipLink GitHub Authorization</title></head>
<body style="font-family:system-ui,sans-serif;padding:32px;color:#0f172a;background:#f8fafc;">
  <div style="max-width:460px;margin:24px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
    <h1 style="font-size:18px;margin:0 0 8px;">${ok ? 'GitHub connected' : 'GitHub authorization incomplete'}</h1>
    <p style="font-size:14px;color:#475569;margin:0 0 12px;">${escapeHtmlText(message)}</p>
    <p style="font-size:12px;color:#64748b;margin:0;">You can close this window and return to ZipLink.</p>
  </div>
  <script nonce="${nonceHtml}">
    (function () {
      var data = ${payloadJson};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(data, '*');
        }
      } catch (e) {}
      if (${ok ? 'true' : 'false'}) {
        setTimeout(function () { window.close(); }, 300);
      }
    })();
  </script>
</body>
</html>`);
    };

    if (errorParam) {
      sendPopupResponse(400, false, errorDesc || `GitHub declined authorization (${errorParam}).`);
      return;
    }

    if (!code || !state) {
      sendPopupResponse(400, false, 'Missing OAuth code or state parameter from GitHub callback.');
      return;
    }

    const nowMs = nowFn();
    const parsedState = parseAndVerifyBoundOAuthState(state, nowMs, config.sessionKey);
    const cookies = parseCookies(req.headers.cookie);
    const cookieState = cookies.get(GITHUB_STATE_COOKIE);
    const cookieMatches = !cookieState || timingSafeHexEqual(cookieState, state);

    if (!parsedState || !cookieMatches) {
      sendPopupResponse(403, false, 'Invalid or expired OAuth state parameter. Please retry connecting.');
      return;
    }

    const pendingState = await storage.consumePendingOAuthState(parsedState.nonce, nowMs);
    if (!pendingState) {
      sendPopupResponse(
        403,
        false,
        'GitHub OAuth state expired or was already consumed. Please retry connecting from ZipLink.',
      );
      return;
    }

    const expectedUidHash = sha256Hex(pendingState.uid).slice(0, 32);
    if (!timingSafeHexEqual(expectedUidHash, parsedState.uidHash)) {
      sendPopupResponse(403, false, 'OAuth state user binding mismatch. Please retry connecting.');
      return;
    }

    if (!config.githubClientId || !config.githubClientSecret) {
      sendPopupResponse(503, false, 'GitHub App client credentials are not configured on this server.');
      return;
    }

    try {
      const callbackUrl = `${resolveBaseUrl(req, config)}/api/github/callback`;
      const tokens = await githubClient.exchangeOAuthCode(code, callbackUrl);
      const githubUser = await githubClient.getAuthenticatedUser(tokens.accessToken);

      const connectionRecord: GitHubConnectionRecord = {
        uid: pendingState.uid,
        user: githubUser,
        encryptedAccessToken: encryptSecret(tokens.accessToken, config.sessionKey),
        encryptedRefreshToken: tokens.refreshToken
          ? encryptSecret(tokens.refreshToken, config.sessionKey)
          : null,
        tokenExpiresAtMs: tokens.expiresInSeconds
          ? nowMs + tokens.expiresInSeconds * 1000
          : null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      await storage.saveGitHubConnection(connectionRecord);

      const secure = isHttpsRequest(req);
      res.setHeader(
        'Set-Cookie',
        formatStateCookie(GITHUB_STATE_COOKIE, '', { maxAgeSeconds: 0, secure }),
      );

      sendPopupResponse(
        200,
        true,
        `Authorized GitHub account @${githubUser.login} for your ZipLink workspace. Returning to ZipLink...`,
        githubUser.login,
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unable to complete GitHub OAuth token exchange.';
      sendPopupResponse(401, false, msg);
    }
  };

  app.get('/api/github/callback', handleGitHubCallback);
  app.get('/api/github/callback/', handleGitHubCallback);

  app.post('/api/github/logout', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, true);
      if (!user) return;
      await storage.deleteGitHubConnection(user.uid);
      res.json({ disconnected: true });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.get('/api/github/repos', readDeleteLimiter, async (req, res, next) => {
    try {
      const ctx = await requireGitHubConnection(req, res, false);
      if (!ctx) return;
      const result = await workspaceService.listAuthorizedRepos(ctx.connection);
      res.json(result);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.post('/api/github/repos', readDeleteLimiter, async (req, res, next) => {
    try {
      const ctx = await requireGitHubConnection(req, res, true);
      if (!ctx) return;
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
      const isPrivate = req.body?.private !== false;
      if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
        res.status(400).json({ error: 'Enter a valid GitHub repository name.' });
        return;
      }
      const token = await workspaceService.getValidAccessToken(ctx.connection);
      const repo = await githubClient.createRepository(token, {
        name,
        description,
        isPrivate,
      });
      res.status(201).json({ repo });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.get('/api/github/repos/:owner/:repo/branches', readDeleteLimiter, async (req, res, next) => {
    try {
      const ctx = await requireGitHubConnection(req, res, false);
      if (!ctx) return;
      const branches = await workspaceService.listRepoBranches(
        ctx.connection,
        req.params.owner,
        req.params.repo,
      );
      res.json({ branches });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.post(
    '/api/github/repos/:owner/:repo/pulls/:pullNumber/merge',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const ctx = await requireGitHubConnection(req, res, true);
        if (!ctx) return;
        const pullNumber = Number.parseInt(req.params.pullNumber, 10);
        const mergeMethodRaw = req.body?.mergeMethod;
        const mergeMethod: 'merge' | 'squash' | 'rebase' =
          mergeMethodRaw === 'squash' || mergeMethodRaw === 'rebase' ? mergeMethodRaw : 'merge';

        const result = await workspaceService.mergePullRequest({
          connection: ctx.connection,
          owner: req.params.owner,
          repo: req.params.repo,
          pullNumber,
          mergeMethod,
          commitTitle: typeof req.body?.commitTitle === 'string' ? req.body.commitTitle : undefined,
          confirmed: req.body?.confirmed === true,
        });
        res.json(result);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  // ==========================================================================
  // Private Per-User GitHub Workspaces API (Verified Firebase UID Isolated)
  // ==========================================================================

  app.get('/api/workspaces', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, false);
      if (!user) return;
      const list = await storage.listWorkspacesByOwner(user.uid);
      res.json({ workspaces: list.map(toWorkspaceSummary) });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.post('/api/workspaces', readDeleteLimiter, async (req, res, next) => {
    try {
      const ctx = await requireGitHubConnection(req, res, true);
      if (!ctx) return;
      const owner = typeof req.body?.owner === 'string' ? req.body.owner.trim() : '';
      const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
      const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
      if (!owner || !repo) {
        res.status(400).json({ error: 'Select an authorized repository owner and name.' });
        return;
      }
      const workspace = await workspaceService.importRepositoryWorkspace({
        connection: ctx.connection,
        owner,
        repo,
        branch,
      });
      res.status(201).json({ workspace });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.get('/api/workspaces/:workspaceId', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, false);
      if (!user) return;
      const workspace = await workspaceService.getOwnedWorkspace(
        req.params.workspaceId,
        user.uid,
      );
      res.json({ workspace });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.delete('/api/workspaces/:workspaceId', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, true);
      if (!user) return;
      await workspaceService.getOwnedWorkspace(req.params.workspaceId, user.uid);
      await storage.deleteWorkspace(req.params.workspaceId);
      res.json({ deleted: true, workspaceId: req.params.workspaceId });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.get(
    '/api/workspaces/:workspaceId/files/:fileId/content',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const user = await requireVerifiedUser(req, res, false);
        if (!user) return;
        const { file, bytes } = await workspaceService.readWorkspaceFile({
          workspaceId: req.params.workspaceId,
          ownerUid: user.uid,
          fileId: req.params.fileId,
        });
        if (!file.isText) {
          res.status(415).json({
            error: 'Binary files cannot be opened in the text editor. Replace or download the raw bytes instead.',
          });
          return;
        }
        if (bytes.byteLength > config.maxTextPreviewBytes) {
          res.status(413).json({
            error: `File exceeds the ${formatBytes(config.maxTextPreviewBytes)} inline editor limit.`,
          });
          return;
        }
        res.json({
          file,
          content: bytes.toString('utf8'),
        });
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/files/:fileId/download',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const user = await requireVerifiedUser(req, res, false);
        if (!user) return;
        const { file, bytes } = await workspaceService.readWorkspaceFile({
          workspaceId: req.params.workspaceId,
          ownerUid: user.uid,
          fileId: req.params.fileId,
        });
        const { asciiFallback, utf8Encoded } = sanitizeContentDispositionFilename(file.path);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
        );
        res.setHeader('Content-Length', String(bytes.byteLength));
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(bytes);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.put(
    '/api/workspaces/:workspaceId/files/:fileId/content',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const user = await requireVerifiedUser(req, res, true);
        if (!user) return;
        if (typeof req.body?.content !== 'string') {
          res.status(400).json({ error: 'Text content string is required.' });
          return;
        }
        const result = await workspaceService.updateTextFile({
          workspaceId: req.params.workspaceId,
          ownerUid: user.uid,
          fileId: req.params.fileId,
          content: req.body.content,
        });
        res.json(result);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/files',
    readDeleteLimiter,
    (req, res, next) => {
      if (req.is('multipart/form-data')) {
        binaryUpload.single('file')(req, res, (err: unknown) => {
          if (err instanceof multer.MulterError) {
            res.status(400).json({ error: `Upload error: ${err.message}` });
            return;
          }
          next(err);
        });
      } else {
        next();
      }
    },
    async (req, res, next) => {
      try {
        const user = await requireVerifiedUser(req, res, true);
        if (!user) return;
        if (req.file) {
          const targetPath =
            (typeof req.body?.path === 'string' && req.body.path.trim()) ||
            req.file.originalname ||
            'uploaded.bin';
          const result = await workspaceService.createFile({
            workspaceId: req.params.workspaceId,
            ownerUid: user.uid,
            filePath: targetPath,
            bytes: req.file.buffer,
          });
          res.status(201).json(result);
          return;
        }

        const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
        const content = typeof req.body?.content === 'string' ? req.body.content : '';
        const result = await workspaceService.createFile({
          workspaceId: req.params.workspaceId,
          ownerUid: user.uid,
          filePath,
          bytes: Buffer.from(content, 'utf8'),
          forceText: true,
        });
        res.status(201).json(result);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/files/:fileId/replace',
    readDeleteLimiter,
    (req, res, next) => {
      binaryUpload.single('file')(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ error: `Upload error: ${err.message}` });
          return;
        }
        next(err);
      });
    },
    async (req, res, next) => {
      try {
        const user = await requireVerifiedUser(req, res, true);
        if (!user) return;
        if (!req.file) {
          res.status(400).json({ error: 'Select a replacement file to upload.' });
          return;
        }
        const result = await workspaceService.replaceBinaryFile({
          workspaceId: req.params.workspaceId,
          ownerUid: user.uid,
          fileId: req.params.fileId,
          bytes: req.file.buffer,
        });
        res.json(result);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.patch(
    '/api/workspaces/:workspaceId/files/:fileId',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const user = await requireVerifiedUser(req, res, true);
        if (!user) return;
        const newPath = typeof req.body?.newPath === 'string' ? req.body.newPath : '';
        const result = await workspaceService.renameFile({
          workspaceId: req.params.workspaceId,
          ownerUid: user.uid,
          fileId: req.params.fileId,
          newPath,
        });
        res.json(result);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.delete(
    '/api/workspaces/:workspaceId/files/:fileId',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const user = await requireVerifiedUser(req, res, true);
        if (!user) return;
        const workspace = await workspaceService.deleteWorkspaceFile({
          workspaceId: req.params.workspaceId,
          ownerUid: user.uid,
          fileId: req.params.fileId,
        });
        res.json({ workspace });
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/pull/check',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const ctx = await requireGitHubConnection(req, res, true);
        if (!ctx) return;
        const result = await workspaceService.checkPullUpdates({
          connection: ctx.connection,
          workspaceId: req.params.workspaceId,
        });
        res.json(result);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/pull/conflict-preview',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const ctx = await requireGitHubConnection(req, res, false);
        if (!ctx) return;
        const conflictPath = typeof req.query.path === 'string' ? req.query.path : '';
        if (!conflictPath) {
          res.status(400).json({ error: 'Query parameter "path" is required.' });
          return;
        }
        const preview = await workspaceService.getConflictPreview({
          connection: ctx.connection,
          workspaceId: req.params.workspaceId,
          conflictPath,
        });
        res.json(preview);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/pull/apply',
    readDeleteLimiter,
    async (req, res, next) => {
      try {
        const ctx = await requireGitHubConnection(req, res, true);
        if (!ctx) return;
        const rawResolutions = req.body?.conflictResolutions;
        const conflictResolutions: Record<string, 'keep_workspace' | 'use_github'> =
          rawResolutions && typeof rawResolutions === 'object' ? rawResolutions : {};
        const confirmedDeletionPaths = Array.isArray(req.body?.confirmedDeletionPaths)
          ? req.body.confirmedDeletionPaths.filter((x: unknown): x is string => typeof x === 'string')
          : [];

        const workspace = await workspaceService.applyPullResolutions({
          connection: ctx.connection,
          workspaceId: req.params.workspaceId,
          conflictResolutions,
          confirmedDeletionPaths,
        });
        res.json({ workspace });
      } catch (err) {
        handleServiceError(err, res, next);
      }
    },
  );

  app.get('/api/workspaces/:workspaceId/diff', readDeleteLimiter, async (req, res, next) => {
    try {
      const ctx = await requireGitHubConnection(req, res, false);
      if (!ctx) return;
      const diff = await workspaceService.getWorkspaceDiff({
        connection: ctx.connection,
        workspaceId: req.params.workspaceId,
      });
      res.json(diff);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.post('/api/workspaces/:workspaceId/push', readDeleteLimiter, async (req, res, next) => {
    try {
      const ctx = await requireGitHubConnection(req, res, true);
      if (!ctx) return;
      const result = await workspaceService.pushWorkspaceToGitHub({
        connection: ctx.connection,
        workspaceId: req.params.workspaceId,
        newBranchName: typeof req.body?.newBranchName === 'string' ? req.body.newBranchName : '',
        commitMessage: typeof req.body?.commitMessage === 'string' ? req.body.commitMessage : '',
        prTitle: typeof req.body?.prTitle === 'string' ? req.body.prTitle : '',
        prBody: typeof req.body?.prBody === 'string' ? req.body.prBody : '',
        createPullRequest: req.body?.createPullRequest !== false,
      });
      res.json(result);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  // ==========================================================================
  // ZIP-to-GitHub Private Staging, Suggestions & Safe Push Routes
  // ==========================================================================

  app.post(
    '/api/zip-to-github/stage',
    uploadLimiter,
    (req, res, next) => {
      if (!verifyMutationCsrf(req, res)) return;
      upload.single('archive')(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              error: `Uploaded ZIP exceeds the ${formatBytes(config.maxCompressedBytes)} compressed size limit.`,
            });
            return;
          }
          res.status(400).json({ error: `Upload error: ${err.message}` });
          return;
        }
        next(err);
      });
    },
    async (req, res, next) => {
      const uploadedFile = req.file;
      const extractTempDir = path.join(os.tmpdir(), `ziplink-ghstage-${crypto.randomUUID()}`);
      try {
        const ctx = await requireGitHubConnection(req, res, false);
        if (!ctx) return;
        if (!uploadedFile) {
          res.status(400).json({ error: 'Please select a .zip archive file to upload.' });
          return;
        }
        const archiveName = sanitizeArchiveFilename(uploadedFile.originalname || 'archive.zip');
        const stage = await workspaceService.stageZipForGitHub({
          connection: ctx.connection,
          zipFilePath: uploadedFile.path,
          archiveName,
          extractTempDir,
        });
        res.status(201).json({ stage });
      } catch (err) {
        handleServiceError(err, res, next);
      } finally {
        if (uploadedFile) {
          await fsp.unlink(uploadedFile.path).catch(() => undefined);
        }
        await fsp.rm(extractTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );

  app.get('/api/zip-to-github/stage/:stageId', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, false);
      if (!user) return;
      const stage = await workspaceService.getOwnedActiveStage(req.params.stageId, user.uid);
      res.json({ stage });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.post('/api/zip-to-github/stage/:stageId/plan', readDeleteLimiter, async (req, res, next) => {
    try {
      const ctx = await requireGitHubConnection(req, res, true);
      if (!ctx) return;
      const owner = typeof req.body?.owner === 'string' ? req.body.owner.trim() : '';
      const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
      const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
      const targetFolder = typeof req.body?.targetFolder === 'string' ? req.body.targetFolder : '';
      const mode = req.body?.mode === 'mirror' ? 'mirror' : 'add_update';
      if (!owner || !repo) {
        res.status(400).json({ error: 'Choose a destination repository owner and name.' });
        return;
      }
      const result = await workspaceService.planZipToGitHub({
        connection: ctx.connection,
        stageId: req.params.stageId,
        owner,
        repo,
        branch,
        targetFolder,
        mode,
      });
      res.json(result);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.post('/api/zip-to-github/stage/:stageId/push', readDeleteLimiter, async (req, res, next) => {
    try {
      const ctx = await requireGitHubConnection(req, res, true);
      if (!ctx) return;
      const owner = typeof req.body?.owner === 'string' ? req.body.owner.trim() : '';
      const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
      const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
      const targetFolder = typeof req.body?.targetFolder === 'string' ? req.body.targetFolder : '';
      const mode = req.body?.mode === 'mirror' ? 'mirror' : 'add_update';

      if (!owner || !repo) {
        res.status(400).json({ error: 'Choose a destination repository owner and name.' });
        return;
      }

      const result = await workspaceService.pushZipStageToGitHub({
        connection: ctx.connection,
        stageId: req.params.stageId,
        owner,
        repo,
        branch,
        targetFolder,
        mode,
        expectedBaseCommitSha:
          typeof req.body?.expectedBaseCommitSha === 'string' ? req.body.expectedBaseCommitSha : '',
        newBranchName: typeof req.body?.newBranchName === 'string' ? req.body.newBranchName : '',
        commitMessage: typeof req.body?.commitMessage === 'string' ? req.body.commitMessage : '',
        prTitle: typeof req.body?.prTitle === 'string' ? req.body.prTitle : '',
        prBody: typeof req.body?.prBody === 'string' ? req.body.prBody : '',
        confirmedMirrorDeletions: req.body?.confirmedMirrorDeletions === true,
        createPullRequest: req.body?.createPullRequest !== false,
      });
      res.json(result);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  app.delete('/api/zip-to-github/stage/:stageId', readDeleteLimiter, async (req, res, next) => {
    try {
      const user = await requireVerifiedUser(req, res, true);
      if (!user) return;
      const stage = await storage.getZipStage(req.params.stageId);
      if (!stage || stage.ownerUid !== user.uid) {
        res.status(404).json({ error: 'Staged ZIP upload not found.' });
        return;
      }
      await storage.deleteZipStage(stage.stageId);
      res.json({ deleted: true });
    } catch (err) {
      handleServiceError(err, res, next);
    }
  });

  // ==========================================================================
  // Unlisted ZIP Sharing Endpoints (Public to Anyone With Share URL)
  // ==========================================================================

  async function resolveActiveShareOrRespond(
    shareId: string,
    res: Response,
  ): Promise<ShareRecord | null> {
    if (!isSafeStorageId(shareId)) {
      res.status(404).json({ error: 'Share link not found.' });
      return null;
    }

    const record = await storage.getShare(shareId);
    if (!record) {
      res.status(404).json({ error: 'This share link does not exist or has been deleted.' });
      return null;
    }

    if (record.expiresAtMs <= nowFn()) {
      await storage.deleteShare(shareId).catch(() => undefined);
      res.status(410).json({ error: 'This share link has expired and its files were deleted.' });
      return null;
    }

    return record;
  }

  app.post(
    '/api/shares',
    uploadLimiter,
    (req, res, next) => {
      upload.single('archive')(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              error: `Uploaded ZIP exceeds the ${formatBytes(config.maxCompressedBytes)} compressed size limit.`,
            });
            return;
          }
          res.status(400).json({ error: `Upload error: ${err.message}` });
          return;
        }
        next(err);
      });
    },
    async (req, res, next) => {
      const uploadedFile = req.file;
      if (!uploadedFile) {
        res.status(400).json({ error: 'Please select a .zip archive file to upload.' });
        return;
      }

      const rawExpiry = req.body?.expiry;
      const expiryOption: ExpiryOption = isValidExpiryOption(rawExpiry) ? rawExpiry : '7d';

      const extractTempDir = path.join(os.tmpdir(), `ziplink-extract-${crypto.randomUUID()}`);

      try {
        const extracted = await safelyExtractZipToTempDir({
          zipFilePath: uploadedFile.path,
          extractTempDir,
          limits: {
            maxExtractedBytes: config.maxExtractedBytes,
            maxEntryCount: config.maxEntryCount,
            maxTextPreviewBytes: config.maxTextPreviewBytes,
          },
        });

        const shareId = crypto.randomBytes(24).toString('base64url');
        const deleteToken = crypto.randomBytes(32).toString('base64url');
        const deleteTokenHash = sha256Hex(deleteToken);

        const createdMs = nowFn();
        const createdAt = new Date(createdMs).toISOString();
        const { expiresAtMs, expiresAt } = resolveExpiryTimestamp(expiryOption, createdMs);
        const archiveName = sanitizeArchiveFilename(uploadedFile.originalname || 'archive.zip');

        const sensitiveWarnings = detectSensitiveFilenames(
          extracted.files.map((item) => item.file.relativePath),
        );

        const contextResult = buildContextMarkdown({
          shareId,
          archiveName,
          createdAt,
          expiresAt,
          entries: extracted.files,
          maxContextBytes: config.maxContextMdBytes,
        });

        const manifestJson = buildManifestJson({
          shareId,
          archiveName,
          createdAt,
          expiresAt,
          totalExtractedBytes: extracted.totalExtractedBytes,
          sensitiveWarnings,
          files: contextResult.updatedFiles,
        });

        const shareRecord: ShareRecord = {
          shareId,
          archiveName,
          createdAt,
          expiresAt,
          expiresAtMs,
          expiryOption,
          totalFiles: contextResult.updatedFiles.length,
          totalExtractedBytes: extracted.totalExtractedBytes,
          contextIncludedCount: contextResult.includedCount,
          contextOmittedCount: contextResult.omittedCount,
          sensitiveWarnings,
          files: contextResult.updatedFiles,
          deleteTokenHash,
        };

        await storage.saveShare({
          share: shareRecord,
          blobTempPaths: extracted.extractedBlobPaths,
          contextMd: contextResult.contextMd,
          manifestJson,
        });

        const baseUrl = resolveBaseUrl(req, config);
        const payload: UploadSuccessPayload = {
          shareId,
          shareUrl: `${baseUrl}/s/${shareId}`,
          contextUrl: `${baseUrl}/s/${shareId}/context.md`,
          manifestUrl: `${baseUrl}/s/${shareId}/manifest.json`,
          deleteUrl: `${baseUrl}/delete/${shareId}?token=${encodeURIComponent(deleteToken)}`,
          deleteToken,
          expiresAt,
          expiryOption,
          archiveName,
          totalFiles: shareRecord.totalFiles,
          totalExtractedBytes: shareRecord.totalExtractedBytes,
          contextIncludedCount: shareRecord.contextIncludedCount,
          contextOmittedCount: shareRecord.contextOmittedCount,
          sensitiveWarnings,
          contextMd: contextResult.contextMd,
        };

        res.status(201).json(payload);
      } catch (err) {
        if (err instanceof ZipExtractionError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      } finally {
        await fsp.unlink(uploadedFile.path).catch(() => undefined);
        await fsp.rm(extractTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );

  app.get('/api/shares/:shareId', readDeleteLimiter, async (req, res) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;
    res.json(stripPrivateShareFields(share));
  });

  app.get('/api/shares/:shareId/files/:fileId/preview', readDeleteLimiter, async (req, res) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const fileEntry = share.files.find((f) => f.id === req.params.fileId);
    if (!fileEntry) {
      res.status(404).json({ error: 'File not found in this share.' });
      return;
    }

    if (!fileEntry.isText) {
      res.status(415).json({ error: 'Binary files cannot be previewed as text. Download the file instead.' });
      return;
    }

    if (fileEntry.sizeBytes > config.maxTextPreviewBytes) {
      res.status(413).json({
        error: `File exceeds the ${formatBytes(config.maxTextPreviewBytes)} inline preview limit. Download the file instead.`,
      });
      return;
    }

    const content = await storage.getTextFileContent(
      share.shareId,
      fileEntry.id,
      config.maxTextPreviewBytes,
    );
    if (content === null) {
      res.status(404).json({ error: 'Stored file contents were not found.' });
      return;
    }

    res.json({
      id: fileEntry.id,
      relativePath: fileEntry.relativePath,
      sizeBytes: fileEntry.sizeBytes,
      isActiveContent: fileEntry.isActiveContent,
      content,
    });
  });

  const serveFileDownload = async (req: Request, res: Response) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const fileEntry = share.files.find((f) => f.id === req.params.fileId);
    if (!fileEntry) {
      res.status(404).type('text/plain').send('File not found.');
      return;
    }

    const fileStreamData = await storage.getFileStream(share.shareId, fileEntry.id);
    if (!fileStreamData) {
      res.status(404).type('text/plain').send('File blob missing.');
      return;
    }

    const { asciiFallback, utf8Encoded } = sanitizeContentDispositionFilename(
      fileEntry.relativePath,
    );

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
    );
    res.setHeader('Content-Length', String(fileStreamData.sizeBytes));
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');

    fileStreamData.stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });
    fileStreamData.stream.pipe(res);
  };

  app.get('/s/:shareId/files/:fileId', readDeleteLimiter, serveFileDownload);
  app.get('/api/shares/:shareId/files/:fileId', readDeleteLimiter, serveFileDownload);

  const serveContextMd = async (req: Request, res: Response) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const contextMd = await storage.getContextMd(share.shareId);
    if (contextMd === null) {
      res.status(404).type('text/plain').send('context.md not found.');
      return;
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="context.md"');
    }
    res.send(contextMd);
  };

  app.get('/s/:shareId/context.md', readDeleteLimiter, serveContextMd);
  app.get('/api/shares/:shareId/context.md', readDeleteLimiter, serveContextMd);

  const serveManifestJson = async (req: Request, res: Response) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const manifest = await storage.getManifestJson(share.shareId);
    if (manifest === null) {
      res.status(404).json({ error: 'manifest.json not found.' });
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="manifest.json"');
    }
    res.send(manifest);
  };

  app.get('/s/:shareId/manifest.json', readDeleteLimiter, serveManifestJson);
  app.get('/api/shares/:shareId/manifest.json', readDeleteLimiter, serveManifestJson);

  const handleDeleteShare = async (req: Request, res: Response) => {
    const { shareId } = req.params;
    if (!isSafeStorageId(shareId)) {
      res.status(404).json({ error: 'Share link not found.' });
      return;
    }

    const rawToken =
      req.get('x-delete-token') ||
      (typeof req.body?.token === 'string' ? req.body.token : '') ||
      (typeof req.query.token === 'string' ? req.query.token : '');

    if (!rawToken || rawToken.length < 16) {
      res.status(401).json({ error: 'A valid delete token is required to delete this share.' });
      return;
    }

    const record = await storage.getShare(shareId);
    if (!record) {
      res.status(404).json({ error: 'Share link not found or already deleted.' });
      return;
    }

    const candidateHash = sha256Hex(rawToken);
    if (!timingSafeHexEqual(candidateHash, record.deleteTokenHash)) {
      res.status(403).json({ error: 'Invalid delete token.' });
      return;
    }

    await storage.deleteShare(shareId);
    res.json({ deleted: true, shareId });
  };

  app.delete('/api/shares/:shareId', readDeleteLimiter, handleDeleteShare);
  app.post('/api/shares/:shareId/delete', readDeleteLimiter, handleDeleteShare);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[ZipLink] Request error:', message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected server error occurred.' });
    }
  });

  return { app, config, storage };
}
