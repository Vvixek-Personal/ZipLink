import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Storage as GcsStorage } from '@google-cloud/storage';
import { Firestore } from '@google-cloud/firestore';
import type {
  GitHubConnectionRecord,
  GitHubWorkspaceRecord,
  PendingOAuthStateRecord,
  ShareRecord,
  ZipStageRecord,
} from '../shared/types.ts';
import type { ZipLinkConfig } from './config.ts';

const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{8,96}$/;

export function isSafeStorageId(id: string): boolean {
  return SAFE_ID_REGEX.test(id);
}

function hashUserStorageKey(uid: string): string {
  return crypto.createHash('sha256').update(uid, 'utf8').digest('hex');
}

export interface StorageProvider {
  readonly driverName: 'local' | 'gcs';
  init(): Promise<void>;

  // Public expiring shares
  saveShare(params: {
    share: ShareRecord;
    blobTempPaths: Map<string, string>;
    contextMd: string;
    manifestJson: string;
  }): Promise<void>;
  getShare(shareId: string): Promise<ShareRecord | null>;
  getFileStream(
    shareId: string,
    fileId: string,
  ): Promise<{ stream: Readable; sizeBytes: number } | null>;
  getTextFileContent(shareId: string, fileId: string, maxBytes: number): Promise<string | null>;
  getContextMd(shareId: string): Promise<string | null>;
  getManifestJson(shareId: string): Promise<string | null>;
  deleteShare(shareId: string): Promise<boolean>;
  purgeExpiredShares(nowMs?: number): Promise<number>;

  // Per-user server-side GitHub connections (keyed by verified Firebase UID)
  saveGitHubConnection(connection: GitHubConnectionRecord): Promise<void>;
  getGitHubConnection(uid: string): Promise<GitHubConnectionRecord | null>;
  deleteGitHubConnection(uid: string): Promise<boolean>;

  // Single-use OAuth state bound to verified Firebase UID
  savePendingOAuthState(record: PendingOAuthStateRecord): Promise<void>;
  consumePendingOAuthState(nonce: string, nowMs?: number): Promise<PendingOAuthStateRecord | null>;

  // Persistent private GitHub workspaces (isolated per Firebase UID)
  saveWorkspace(workspace: GitHubWorkspaceRecord): Promise<void>;
  getWorkspace(workspaceId: string): Promise<GitHubWorkspaceRecord | null>;
  listWorkspacesByOwner(ownerUid: string): Promise<GitHubWorkspaceRecord[]>;
  deleteWorkspace(workspaceId: string): Promise<boolean>;
  saveWorkspaceBlob(workspaceId: string, blobId: string, content: Buffer): Promise<void>;
  getWorkspaceBlob(workspaceId: string, blobId: string): Promise<Buffer | null>;
  deleteWorkspaceBlob(workspaceId: string, blobId: string): Promise<void>;

  // Private ZIP-to-GitHub staging (isolated per Firebase UID, never exposed as public share)
  saveZipStage(params: {
    stage: ZipStageRecord;
    blobTempPaths: Map<string, string>;
  }): Promise<void>;
  getZipStage(stageId: string): Promise<ZipStageRecord | null>;
  getZipStageBlob(stageId: string, fileId: string): Promise<Buffer | null>;
  deleteZipStage(stageId: string): Promise<boolean>;

  // Full self-service user data deletion (leaves public ZIP shares & other users untouched)
  deleteAllUserData(ownerUid: string): Promise<{
    deletedWorkspaces: number;
    deletedStages: number;
    disconnectedGitHub: boolean;
  }>;
}

export class LocalStorageProvider implements StorageProvider {
  readonly driverName = 'local' as const;
  private readonly sharesDir: string;
  private readonly blobsDir: string;
  private readonly connectionsDir: string;
  private readonly oauthStatesDir: string;
  private readonly workspacesDir: string;
  private readonly workspaceBlobsDir: string;
  private readonly zipStagesDir: string;

  constructor(baseDir: string) {
    const resolvedBase = path.resolve(baseDir);
    this.sharesDir = path.resolve(resolvedBase, 'shares');
    this.blobsDir = path.resolve(resolvedBase, 'blobs');
    this.connectionsDir = path.resolve(resolvedBase, 'github_connections');
    this.oauthStatesDir = path.resolve(resolvedBase, 'oauth_states');
    this.workspacesDir = path.resolve(resolvedBase, 'workspaces');
    this.workspaceBlobsDir = path.resolve(resolvedBase, 'workspace_blobs');
    this.zipStagesDir = path.resolve(resolvedBase, 'zip_stages');
  }

  async init(): Promise<void> {
    await Promise.all([
      fsp.mkdir(this.sharesDir, { recursive: true }),
      fsp.mkdir(this.blobsDir, { recursive: true }),
      fsp.mkdir(this.connectionsDir, { recursive: true }),
      fsp.mkdir(this.oauthStatesDir, { recursive: true }),
      fsp.mkdir(this.workspacesDir, { recursive: true }),
      fsp.mkdir(this.workspaceBlobsDir, { recursive: true }),
      fsp.mkdir(this.zipStagesDir, { recursive: true }),
    ]);
  }

  private resolveConfinedFile(baseDir: string, id: string, suffix = ''): string {
    if (!isSafeStorageId(id)) {
      throw new Error('Invalid storage identifier.');
    }
    const target = path.resolve(baseDir, `${id}${suffix}`);
    if (!target.startsWith(baseDir + path.sep)) {
      throw new Error('Path confinement violation.');
    }
    return target;
  }

  private resolveConfinedSubFile(baseDir: string, parentId: string, childName: string): string {
    if (!isSafeStorageId(parentId)) {
      throw new Error('Invalid parent storage identifier.');
    }
    const parentDir = path.resolve(baseDir, parentId);
    if (!parentDir.startsWith(baseDir + path.sep)) {
      throw new Error('Path confinement violation on parent directory.');
    }
    const target = path.resolve(parentDir, childName);
    if (!target.startsWith(parentDir + path.sep)) {
      throw new Error('Path confinement violation on child file.');
    }
    return target;
  }

  private async atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmpPath, targetPath);
  }

  // --------------------------------------------------------------------------
  // Shares
  // --------------------------------------------------------------------------

  async saveShare(params: {
    share: ShareRecord;
    blobTempPaths: Map<string, string>;
    contextMd: string;
    manifestJson: string;
  }): Promise<void> {
    const { share, blobTempPaths, contextMd, manifestJson } = params;
    await this.init();

    const shareBlobDir = this.resolveConfinedFile(this.blobsDir, share.shareId);
    await fsp.mkdir(shareBlobDir, { recursive: true });

    try {
      for (const [fileId, tempPath] of blobTempPaths.entries()) {
        if (!isSafeStorageId(fileId)) {
          throw new Error('Invalid generated file ID.');
        }
        const destPath = this.resolveConfinedSubFile(this.blobsDir, share.shareId, fileId);
        try {
          await fsp.rename(tempPath, destPath);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
            await fsp.copyFile(tempPath, destPath);
            await fsp.unlink(tempPath);
          } else {
            throw err;
          }
        }
      }

      await fsp.writeFile(
        this.resolveConfinedSubFile(this.blobsDir, share.shareId, 'context.md'),
        contextMd,
        'utf8',
      );
      await fsp.writeFile(
        this.resolveConfinedSubFile(this.blobsDir, share.shareId, 'manifest.json'),
        manifestJson,
        'utf8',
      );

      await this.atomicWriteJson(
        this.resolveConfinedFile(this.sharesDir, share.shareId, '.json'),
        share,
      );
    } catch (err) {
      await fsp.rm(shareBlobDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async getShare(shareId: string): Promise<ShareRecord | null> {
    if (!isSafeStorageId(shareId)) return null;
    try {
      const raw = await fsp.readFile(
        this.resolveConfinedFile(this.sharesDir, shareId, '.json'),
        'utf8',
      );
      return JSON.parse(raw) as ShareRecord;
    } catch {
      return null;
    }
  }

  async getFileStream(
    shareId: string,
    fileId: string,
  ): Promise<{ stream: Readable; sizeBytes: number } | null> {
    if (!isSafeStorageId(shareId) || !isSafeStorageId(fileId)) return null;
    try {
      const filePath = this.resolveConfinedSubFile(this.blobsDir, shareId, fileId);
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return null;
      return { stream: fs.createReadStream(filePath), sizeBytes: stat.size };
    } catch {
      return null;
    }
  }

  async getTextFileContent(
    shareId: string,
    fileId: string,
    maxBytes: number,
  ): Promise<string | null> {
    if (!isSafeStorageId(shareId) || !isSafeStorageId(fileId)) return null;
    try {
      const filePath = this.resolveConfinedSubFile(this.blobsDir, shareId, fileId);
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      return await fsp.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  async getContextMd(shareId: string): Promise<string | null> {
    if (!isSafeStorageId(shareId)) return null;
    try {
      return await fsp.readFile(
        this.resolveConfinedSubFile(this.blobsDir, shareId, 'context.md'),
        'utf8',
      );
    } catch {
      return null;
    }
  }

  async getManifestJson(shareId: string): Promise<string | null> {
    if (!isSafeStorageId(shareId)) return null;
    try {
      return await fsp.readFile(
        this.resolveConfinedSubFile(this.blobsDir, shareId, 'manifest.json'),
        'utf8',
      );
    } catch {
      return null;
    }
  }

  async deleteShare(shareId: string): Promise<boolean> {
    if (!isSafeStorageId(shareId)) return false;
    const metaPath = this.resolveConfinedFile(this.sharesDir, shareId, '.json');
    const blobDir = this.resolveConfinedFile(this.blobsDir, shareId);

    let existed = false;
    try {
      await fsp.unlink(metaPath);
      existed = true;
    } catch {
      existed = false;
    }
    await fsp.rm(blobDir, { recursive: true, force: true }).catch(() => undefined);
    return existed;
  }

  async purgeExpiredShares(nowMs: number = Date.now()): Promise<number> {
    await this.init();
    let purged = 0;

    // 1. Expired public shares
    const shareEntries = await fsp.readdir(this.sharesDir, { withFileTypes: true });
    for (const entry of shareEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const shareId = entry.name.slice(0, -'.json'.length);
      if (!isSafeStorageId(shareId)) continue;
      const record = await this.getShare(shareId);
      if (!record || record.expiresAtMs <= nowMs) {
        if (await this.deleteShare(shareId)) purged++;
      }
    }

    // 2. Expired pending OAuth states
    const stateEntries = await fsp.readdir(this.oauthStatesDir, { withFileTypes: true });
    for (const entry of stateEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const nonce = entry.name.slice(0, -'.json'.length);
      if (!isSafeStorageId(nonce)) continue;
      try {
        const target = this.resolveConfinedFile(this.oauthStatesDir, nonce, '.json');
        const parsed = JSON.parse(await fsp.readFile(target, 'utf8')) as PendingOAuthStateRecord;
        if (!parsed || parsed.expiresAtMs <= nowMs) {
          await fsp.unlink(target).catch(() => undefined);
        }
      } catch {
        // ignore unreadable temp file
      }
    }

    // 3. Expired private ZIP stages
    const stageEntries = await fsp.readdir(this.zipStagesDir, { withFileTypes: true });
    for (const entry of stageEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const stageId = entry.name.slice(0, -'.json'.length);
      if (!isSafeStorageId(stageId)) continue;
      const stage = await this.getZipStage(stageId);
      if (!stage || stage.expiresAtMs <= nowMs) {
        await this.deleteZipStage(stageId);
      }
    }

    return purged;
  }

  // --------------------------------------------------------------------------
  // Per-User GitHub Connections
  // --------------------------------------------------------------------------

  async saveGitHubConnection(connection: GitHubConnectionRecord): Promise<void> {
    await this.init();
    const key = hashUserStorageKey(connection.uid);
    await this.atomicWriteJson(
      this.resolveConfinedFile(this.connectionsDir, key, '.json'),
      connection,
    );
  }

  async getGitHubConnection(uid: string): Promise<GitHubConnectionRecord | null> {
    if (!uid) return null;
    try {
      const key = hashUserStorageKey(uid);
      const raw = await fsp.readFile(
        this.resolveConfinedFile(this.connectionsDir, key, '.json'),
        'utf8',
      );
      const parsed = JSON.parse(raw) as GitHubConnectionRecord;
      return parsed.uid === uid ? parsed : null;
    } catch {
      return null;
    }
  }

  async deleteGitHubConnection(uid: string): Promise<boolean> {
    if (!uid) return false;
    try {
      const key = hashUserStorageKey(uid);
      await fsp.unlink(this.resolveConfinedFile(this.connectionsDir, key, '.json'));
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Single-Use OAuth States
  // --------------------------------------------------------------------------

  async savePendingOAuthState(record: PendingOAuthStateRecord): Promise<void> {
    await this.init();
    await this.atomicWriteJson(
      this.resolveConfinedFile(this.oauthStatesDir, record.nonce, '.json'),
      record,
    );
  }

  async consumePendingOAuthState(
    nonce: string,
    nowMs: number = Date.now(),
  ): Promise<PendingOAuthStateRecord | null> {
    if (!isSafeStorageId(nonce)) return null;
    const target = this.resolveConfinedFile(this.oauthStatesDir, nonce, '.json');
    try {
      const raw = await fsp.readFile(target, 'utf8');
      await fsp.unlink(target);
      const parsed = JSON.parse(raw) as PendingOAuthStateRecord;
      if (!parsed || parsed.nonce !== nonce || parsed.expiresAtMs <= nowMs) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Workspaces
  // --------------------------------------------------------------------------

  async saveWorkspace(workspace: GitHubWorkspaceRecord): Promise<void> {
    await this.init();
    await this.atomicWriteJson(
      this.resolveConfinedFile(this.workspacesDir, workspace.workspaceId, '.json'),
      workspace,
    );
  }

  async getWorkspace(workspaceId: string): Promise<GitHubWorkspaceRecord | null> {
    if (!isSafeStorageId(workspaceId)) return null;
    try {
      const raw = await fsp.readFile(
        this.resolveConfinedFile(this.workspacesDir, workspaceId, '.json'),
        'utf8',
      );
      return JSON.parse(raw) as GitHubWorkspaceRecord;
    } catch {
      return null;
    }
  }

  async listWorkspacesByOwner(ownerUid: string): Promise<GitHubWorkspaceRecord[]> {
    await this.init();
    const entries = await fsp.readdir(this.workspacesDir, { withFileTypes: true });
    const results: GitHubWorkspaceRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      if (!isSafeStorageId(id)) continue;
      const ws = await this.getWorkspace(id);
      if (ws && ws.ownerUid === ownerUid) {
        results.push(ws);
      }
    }
    return results.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    if (!isSafeStorageId(workspaceId)) return false;
    let existed = false;
    try {
      await fsp.unlink(this.resolveConfinedFile(this.workspacesDir, workspaceId, '.json'));
      existed = true;
    } catch {
      existed = false;
    }
    const blobDir = this.resolveConfinedFile(this.workspaceBlobsDir, workspaceId);
    await fsp.rm(blobDir, { recursive: true, force: true }).catch(() => undefined);
    return existed;
  }

  async saveWorkspaceBlob(workspaceId: string, blobId: string, content: Buffer): Promise<void> {
    if (!isSafeStorageId(workspaceId) || !isSafeStorageId(blobId)) {
      throw new Error('Invalid workspace or blob identifier.');
    }
    const wsBlobDir = this.resolveConfinedFile(this.workspaceBlobsDir, workspaceId);
    await fsp.mkdir(wsBlobDir, { recursive: true });
    const destPath = this.resolveConfinedSubFile(this.workspaceBlobsDir, workspaceId, blobId);
    await fsp.writeFile(destPath, content);
  }

  async getWorkspaceBlob(workspaceId: string, blobId: string): Promise<Buffer | null> {
    if (!isSafeStorageId(workspaceId) || !isSafeStorageId(blobId)) return null;
    try {
      const target = this.resolveConfinedSubFile(this.workspaceBlobsDir, workspaceId, blobId);
      return await fsp.readFile(target);
    } catch {
      return null;
    }
  }

  async deleteWorkspaceBlob(workspaceId: string, blobId: string): Promise<void> {
    if (!isSafeStorageId(workspaceId) || !isSafeStorageId(blobId)) return;
    try {
      const target = this.resolveConfinedSubFile(this.workspaceBlobsDir, workspaceId, blobId);
      await fsp.unlink(target);
    } catch {
      // ignore missing
    }
  }

  // --------------------------------------------------------------------------
  // ZIP Stages (Private)
  // --------------------------------------------------------------------------

  async saveZipStage(params: {
    stage: ZipStageRecord;
    blobTempPaths: Map<string, string>;
  }): Promise<void> {
    const { stage, blobTempPaths } = params;
    await this.init();

    const stageBlobDir = this.resolveConfinedFile(this.zipStagesDir, stage.stageId);
    await fsp.mkdir(stageBlobDir, { recursive: true });

    try {
      for (const [fileId, tempPath] of blobTempPaths.entries()) {
        if (!isSafeStorageId(fileId)) throw new Error('Invalid stage file ID.');
        const destPath = this.resolveConfinedSubFile(this.zipStagesDir, stage.stageId, fileId);
        try {
          await fsp.rename(tempPath, destPath);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
            await fsp.copyFile(tempPath, destPath);
            await fsp.unlink(tempPath);
          } else {
            throw err;
          }
        }
      }

      await this.atomicWriteJson(
        this.resolveConfinedFile(this.zipStagesDir, stage.stageId, '.json'),
        stage,
      );
    } catch (err) {
      await fsp.rm(stageBlobDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async getZipStage(stageId: string): Promise<ZipStageRecord | null> {
    if (!isSafeStorageId(stageId)) return null;
    try {
      const raw = await fsp.readFile(
        this.resolveConfinedFile(this.zipStagesDir, stageId, '.json'),
        'utf8',
      );
      return JSON.parse(raw) as ZipStageRecord;
    } catch {
      return null;
    }
  }

  async getZipStageBlob(stageId: string, fileId: string): Promise<Buffer | null> {
    if (!isSafeStorageId(stageId) || !isSafeStorageId(fileId)) return null;
    try {
      return await fsp.readFile(this.resolveConfinedSubFile(this.zipStagesDir, stageId, fileId));
    } catch {
      return null;
    }
  }

  async deleteZipStage(stageId: string): Promise<boolean> {
    if (!isSafeStorageId(stageId)) return false;
    let existed = false;
    try {
      await fsp.unlink(this.resolveConfinedFile(this.zipStagesDir, stageId, '.json'));
      existed = true;
    } catch {
      existed = false;
    }
    const stageBlobDir = this.resolveConfinedFile(this.zipStagesDir, stageId);
    await fsp.rm(stageBlobDir, { recursive: true, force: true }).catch(() => undefined);
    return existed;
  }

  async deleteAllUserData(ownerUid: string): Promise<{
    deletedWorkspaces: number;
    deletedStages: number;
    disconnectedGitHub: boolean;
  }> {
    await this.init();
    const disconnectedGitHub = await this.deleteGitHubConnection(ownerUid);

    const ownedWorkspaces = await this.listWorkspacesByOwner(ownerUid);
    let deletedWorkspaces = 0;
    for (const ws of ownedWorkspaces) {
      if (await this.deleteWorkspace(ws.workspaceId)) {
        deletedWorkspaces++;
      }
    }

    let deletedStages = 0;
    const stageEntries = await fsp.readdir(this.zipStagesDir, { withFileTypes: true });
    for (const entry of stageEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const stageId = entry.name.slice(0, -'.json'.length);
      if (!isSafeStorageId(stageId)) continue;
      const stage = await this.getZipStage(stageId);
      if (stage && stage.ownerUid === ownerUid) {
        if (await this.deleteZipStage(stageId)) {
          deletedStages++;
        }
      }
    }

    return {
      deletedWorkspaces,
      deletedStages,
      disconnectedGitHub,
    };
  }
}

export class GcsFirestoreStorageProvider implements StorageProvider {
  readonly driverName = 'gcs' as const;
  private readonly storage: GcsStorage;
  private readonly firestore: Firestore;
  private readonly bucketName: string;
  private readonly collectionName: string;

  constructor(config: { bucketName: string; projectId?: string; collectionName: string }) {
    this.bucketName = config.bucketName;
    this.collectionName = config.collectionName;
    this.storage = new GcsStorage(config.projectId ? { projectId: config.projectId } : undefined);
    this.firestore = new Firestore(
      config.projectId ? { projectId: config.projectId } : undefined,
    );
  }

  async init(): Promise<void> {
    // Cloud resources provisioned externally
  }

  private blobObjectKey(shareId: string, name: string): string {
    if (!isSafeStorageId(shareId)) throw new Error('Invalid share identifier.');
    return `shares/${shareId}/${name}`;
  }

  async saveShare(params: {
    share: ShareRecord;
    blobTempPaths: Map<string, string>;
    contextMd: string;
    manifestJson: string;
  }): Promise<void> {
    const { share, blobTempPaths, contextMd, manifestJson } = params;
    const bucket = this.storage.bucket(this.bucketName);

    const uploadPromises: Promise<unknown>[] = [];
    for (const [fileId, tempPath] of blobTempPaths.entries()) {
      if (!isSafeStorageId(fileId)) throw new Error('Invalid generated file ID.');
      uploadPromises.push(
        bucket.upload(tempPath, {
          destination: this.blobObjectKey(share.shareId, `files/${fileId}`),
          resumable: false,
          metadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
        }),
      );
    }

    uploadPromises.push(
      bucket
        .file(this.blobObjectKey(share.shareId, 'context.md'))
        .save(contextMd, { contentType: 'text/markdown; charset=utf-8' }),
    );
    uploadPromises.push(
      bucket
        .file(this.blobObjectKey(share.shareId, 'manifest.json'))
        .save(manifestJson, { contentType: 'application/json; charset=utf-8' }),
    );

    await Promise.all(uploadPromises);
    await this.firestore
      .collection(this.collectionName)
      .doc(share.shareId)
      .set({ ...share, expireAtDate: new Date(share.expiresAtMs) });
  }

  async getShare(shareId: string): Promise<ShareRecord | null> {
    if (!isSafeStorageId(shareId)) return null;
    const snap = await this.firestore.collection(this.collectionName).doc(shareId).get();
    return snap.exists ? (snap.data() as ShareRecord) : null;
  }

  async getFileStream(
    shareId: string,
    fileId: string,
  ): Promise<{ stream: Readable; sizeBytes: number } | null> {
    if (!isSafeStorageId(shareId) || !isSafeStorageId(fileId)) return null;
    const file = this.storage
      .bucket(this.bucketName)
      .file(this.blobObjectKey(shareId, `files/${fileId}`));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [meta] = await file.getMetadata();
    return { stream: file.createReadStream(), sizeBytes: Number(meta.size || 0) };
  }

  async getTextFileContent(
    shareId: string,
    fileId: string,
    maxBytes: number,
  ): Promise<string | null> {
    if (!isSafeStorageId(shareId) || !isSafeStorageId(fileId)) return null;
    const file = this.storage
      .bucket(this.bucketName)
      .file(this.blobObjectKey(shareId, `files/${fileId}`));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [meta] = await file.getMetadata();
    if (Number(meta.size || 0) > maxBytes) return null;
    const [buf] = await file.download();
    return buf.toString('utf8');
  }

  async getContextMd(shareId: string): Promise<string | null> {
    if (!isSafeStorageId(shareId)) return null;
    const file = this.storage.bucket(this.bucketName).file(this.blobObjectKey(shareId, 'context.md'));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return buf.toString('utf8');
  }

  async getManifestJson(shareId: string): Promise<string | null> {
    if (!isSafeStorageId(shareId)) return null;
    const file = this.storage
      .bucket(this.bucketName)
      .file(this.blobObjectKey(shareId, 'manifest.json'));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return buf.toString('utf8');
  }

  async deleteShare(shareId: string): Promise<boolean> {
    if (!isSafeStorageId(shareId)) return false;
    const docRef = this.firestore.collection(this.collectionName).doc(shareId);
    const snap = await docRef.get();
    await this.storage.bucket(this.bucketName).deleteFiles({ prefix: `shares/${shareId}/`, force: true });
    if (snap.exists) {
      await docRef.delete();
      return true;
    }
    return false;
  }

  async purgeExpiredShares(nowMs: number = Date.now()): Promise<number> {
    const snapshot = await this.firestore
      .collection(this.collectionName)
      .where('expiresAtMs', '<=', nowMs)
      .limit(100)
      .get();

    let purged = 0;
    for (const doc of snapshot.docs) {
      if (await this.deleteShare(doc.id)) purged++;
    }

    const stagesSnap = await this.firestore
      .collection(`${this.collectionName}_zip_stages`)
      .where('expiresAtMs', '<=', nowMs)
      .limit(100)
      .get();
    for (const doc of stagesSnap.docs) {
      await this.deleteZipStage(doc.id);
    }

    const oauthSnap = await this.firestore
      .collection(`${this.collectionName}_oauth_states`)
      .where('expiresAtMs', '<=', nowMs)
      .limit(100)
      .get();
    for (const doc of oauthSnap.docs) {
      await doc.ref.delete().catch(() => undefined);
    }

    return purged;
  }

  async saveGitHubConnection(connection: GitHubConnectionRecord): Promise<void> {
    const key = hashUserStorageKey(connection.uid);
    await this.firestore
      .collection(`${this.collectionName}_github_connections`)
      .doc(key)
      .set(connection);
  }

  async getGitHubConnection(uid: string): Promise<GitHubConnectionRecord | null> {
    if (!uid) return null;
    const key = hashUserStorageKey(uid);
    const snap = await this.firestore
      .collection(`${this.collectionName}_github_connections`)
      .doc(key)
      .get();
    if (!snap.exists) return null;
    const data = snap.data() as GitHubConnectionRecord;
    return data.uid === uid ? data : null;
  }

  async deleteGitHubConnection(uid: string): Promise<boolean> {
    if (!uid) return false;
    const key = hashUserStorageKey(uid);
    const ref = this.firestore.collection(`${this.collectionName}_github_connections`).doc(key);
    const snap = await ref.get();
    await ref.delete();
    return snap.exists;
  }

  async savePendingOAuthState(record: PendingOAuthStateRecord): Promise<void> {
    if (!isSafeStorageId(record.nonce)) throw new Error('Invalid OAuth state nonce.');
    await this.firestore
      .collection(`${this.collectionName}_oauth_states`)
      .doc(record.nonce)
      .set(record);
  }

  async consumePendingOAuthState(
    nonce: string,
    nowMs: number = Date.now(),
  ): Promise<PendingOAuthStateRecord | null> {
    if (!isSafeStorageId(nonce)) return null;
    const ref = this.firestore.collection(`${this.collectionName}_oauth_states`).doc(nonce);
    const snap = await ref.get();
    if (!snap.exists) return null;
    await ref.delete();
    const parsed = snap.data() as PendingOAuthStateRecord;
    if (!parsed || parsed.nonce !== nonce || parsed.expiresAtMs <= nowMs) {
      return null;
    }
    return parsed;
  }

  async saveWorkspace(workspace: GitHubWorkspaceRecord): Promise<void> {
    await this.firestore
      .collection(`${this.collectionName}_workspaces`)
      .doc(workspace.workspaceId)
      .set(workspace);
  }

  async getWorkspace(workspaceId: string): Promise<GitHubWorkspaceRecord | null> {
    if (!isSafeStorageId(workspaceId)) return null;
    const snap = await this.firestore
      .collection(`${this.collectionName}_workspaces`)
      .doc(workspaceId)
      .get();
    return snap.exists ? (snap.data() as GitHubWorkspaceRecord) : null;
  }

  async listWorkspacesByOwner(ownerUid: string): Promise<GitHubWorkspaceRecord[]> {
    const snap = await this.firestore
      .collection(`${this.collectionName}_workspaces`)
      .where('ownerUid', '==', ownerUid)
      .get();
    return snap.docs
      .map((d) => d.data() as GitHubWorkspaceRecord)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    if (!isSafeStorageId(workspaceId)) return false;
    await this.storage
      .bucket(this.bucketName)
      .deleteFiles({ prefix: `workspaces/${workspaceId}/`, force: true });
    await this.firestore
      .collection(`${this.collectionName}_workspaces`)
      .doc(workspaceId)
      .delete();
    return true;
  }

  async saveWorkspaceBlob(workspaceId: string, blobId: string, content: Buffer): Promise<void> {
    if (!isSafeStorageId(workspaceId) || !isSafeStorageId(blobId)) {
      throw new Error('Invalid workspace or blob identifier.');
    }
    await this.storage
      .bucket(this.bucketName)
      .file(`workspaces/${workspaceId}/blobs/${blobId}`)
      .save(content, { contentType: 'application/octet-stream', resumable: false });
  }

  async getWorkspaceBlob(workspaceId: string, blobId: string): Promise<Buffer | null> {
    if (!isSafeStorageId(workspaceId) || !isSafeStorageId(blobId)) return null;
    const file = this.storage.bucket(this.bucketName).file(`workspaces/${workspaceId}/blobs/${blobId}`);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return buf;
  }

  async deleteWorkspaceBlob(workspaceId: string, blobId: string): Promise<void> {
    if (!isSafeStorageId(workspaceId) || !isSafeStorageId(blobId)) return;
    await this.storage
      .bucket(this.bucketName)
      .file(`workspaces/${workspaceId}/blobs/${blobId}`)
      .delete({ ignoreNotFound: true });
  }

  async saveZipStage(params: {
    stage: ZipStageRecord;
    blobTempPaths: Map<string, string>;
  }): Promise<void> {
    const { stage, blobTempPaths } = params;
    const bucket = this.storage.bucket(this.bucketName);
    const uploads: Promise<unknown>[] = [];
    for (const [fileId, tempPath] of blobTempPaths.entries()) {
      if (!isSafeStorageId(fileId)) throw new Error('Invalid stage file ID.');
      uploads.push(
        bucket.upload(tempPath, {
          destination: `zip_stages/${stage.stageId}/${fileId}`,
          resumable: false,
          metadata: { contentType: 'application/octet-stream' },
        }),
      );
    }
    await Promise.all(uploads);
    await this.firestore
      .collection(`${this.collectionName}_zip_stages`)
      .doc(stage.stageId)
      .set(stage);
  }

  async getZipStage(stageId: string): Promise<ZipStageRecord | null> {
    if (!isSafeStorageId(stageId)) return null;
    const snap = await this.firestore
      .collection(`${this.collectionName}_zip_stages`)
      .doc(stageId)
      .get();
    return snap.exists ? (snap.data() as ZipStageRecord) : null;
  }

  async getZipStageBlob(stageId: string, fileId: string): Promise<Buffer | null> {
    if (!isSafeStorageId(stageId) || !isSafeStorageId(fileId)) return null;
    const file = this.storage.bucket(this.bucketName).file(`zip_stages/${stageId}/${fileId}`);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return buf;
  }

  async deleteZipStage(stageId: string): Promise<boolean> {
    if (!isSafeStorageId(stageId)) return false;
    await this.storage
      .bucket(this.bucketName)
      .deleteFiles({ prefix: `zip_stages/${stageId}/`, force: true });
    await this.firestore.collection(`${this.collectionName}_zip_stages`).doc(stageId).delete();
    return true;
  }

  async deleteAllUserData(ownerUid: string): Promise<{
    deletedWorkspaces: number;
    deletedStages: number;
    disconnectedGitHub: boolean;
  }> {
    const disconnectedGitHub = await this.deleteGitHubConnection(ownerUid);
    const workspaces = await this.listWorkspacesByOwner(ownerUid);
    let deletedWorkspaces = 0;
    for (const ws of workspaces) {
      if (await this.deleteWorkspace(ws.workspaceId)) {
        deletedWorkspaces++;
      }
    }

    const stagesSnap = await this.firestore
      .collection(`${this.collectionName}_zip_stages`)
      .where('ownerUid', '==', ownerUid)
      .get();
    let deletedStages = 0;
    for (const doc of stagesSnap.docs) {
      if (await this.deleteZipStage(doc.id)) {
        deletedStages++;
      }
    }

    return {
      deletedWorkspaces,
      deletedStages,
      disconnectedGitHub,
    };
  }
}

export function createStorageProvider(config: ZipLinkConfig): StorageProvider {
  if (config.storageDriver === 'gcs' && config.gcsBucket) {
    return new GcsFirestoreStorageProvider({
      bucketName: config.gcsBucket,
      projectId: config.gcpProjectId || undefined,
      collectionName: config.firestoreCollection,
    });
  }
  return new LocalStorageProvider(config.dataDir);
}
