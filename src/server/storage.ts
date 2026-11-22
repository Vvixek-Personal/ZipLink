import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Storage as GcsStorage } from '@google-cloud/storage';
import { Firestore } from '@google-cloud/firestore';
import type { ShareRecord } from '../shared/types.ts';
import type { ZipLinkConfig } from './config.ts';

const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

export function isSafeStorageId(id: string): boolean {
  return SAFE_ID_REGEX.test(id);
}

export interface StorageProvider {
  readonly driverName: 'local' | 'gcs';
  init(): Promise<void>;
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
}

export class LocalStorageProvider implements StorageProvider {
  readonly driverName = 'local' as const;
  private readonly sharesDir: string;
  private readonly blobsDir: string;

  constructor(baseDir: string) {
    const resolvedBase = path.resolve(baseDir);
    this.sharesDir = path.resolve(resolvedBase, 'shares');
    this.blobsDir = path.resolve(resolvedBase, 'blobs');
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.sharesDir, { recursive: true });
    await fsp.mkdir(this.blobsDir, { recursive: true });
  }

  private resolveShareMetaPath(shareId: string): string {
    if (!isSafeStorageId(shareId)) {
      throw new Error('Invalid share identifier.');
    }
    const target = path.resolve(this.sharesDir, `${shareId}.json`);
    if (!target.startsWith(this.sharesDir + path.sep)) {
      throw new Error('Path confinement violation on share metadata.');
    }
    return target;
  }

  private resolveShareBlobDir(shareId: string): string {
    if (!isSafeStorageId(shareId)) {
      throw new Error('Invalid share identifier.');
    }
    const target = path.resolve(this.blobsDir, shareId);
    if (!target.startsWith(this.blobsDir + path.sep)) {
      throw new Error('Path confinement violation on share blob directory.');
    }
    return target;
  }

  private resolveBlobFilePath(shareId: string, fileName: string): string {
    const shareDir = this.resolveShareBlobDir(shareId);
    const target = path.resolve(shareDir, fileName);
    if (!target.startsWith(shareDir + path.sep)) {
      throw new Error('Path confinement violation on blob file.');
    }
    return target;
  }

  async saveShare(params: {
    share: ShareRecord;
    blobTempPaths: Map<string, string>;
    contextMd: string;
    manifestJson: string;
  }): Promise<void> {
    const { share, blobTempPaths, contextMd, manifestJson } = params;
    await this.init();

    const shareBlobDir = this.resolveShareBlobDir(share.shareId);
    await fsp.mkdir(shareBlobDir, { recursive: true });

    try {
      for (const [fileId, tempPath] of blobTempPaths.entries()) {
        if (!isSafeStorageId(fileId)) {
          throw new Error('Invalid generated file ID.');
        }
        const destPath = this.resolveBlobFilePath(share.shareId, fileId);
        try {
          await fsp.rename(tempPath, destPath);
        } catch (err: unknown) {
          // Cross-device rename fallback
          if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
            await fsp.copyFile(tempPath, destPath);
            await fsp.unlink(tempPath);
          } else {
            throw err;
          }
        }
      }

      await fsp.writeFile(this.resolveBlobFilePath(share.shareId, 'context.md'), contextMd, 'utf8');
      await fsp.writeFile(
        this.resolveBlobFilePath(share.shareId, 'manifest.json'),
        manifestJson,
        'utf8',
      );

      const metaPath = this.resolveShareMetaPath(share.shareId);
      const tmpMetaPath = `${metaPath}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmpMetaPath, JSON.stringify(share, null, 2), 'utf8');
      await fsp.rename(tmpMetaPath, metaPath);
    } catch (err) {
      await fsp.rm(shareBlobDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async getShare(shareId: string): Promise<ShareRecord | null> {
    if (!isSafeStorageId(shareId)) return null;
    try {
      const metaPath = this.resolveShareMetaPath(shareId);
      const raw = await fsp.readFile(metaPath, 'utf8');
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
      const filePath = this.resolveBlobFilePath(shareId, fileId);
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return null;
      return {
        stream: fs.createReadStream(filePath),
        sizeBytes: stat.size,
      };
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
      const filePath = this.resolveBlobFilePath(shareId, fileId);
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
      return await fsp.readFile(this.resolveBlobFilePath(shareId, 'context.md'), 'utf8');
    } catch {
      return null;
    }
  }

  async getManifestJson(shareId: string): Promise<string | null> {
    if (!isSafeStorageId(shareId)) return null;
    try {
      return await fsp.readFile(this.resolveBlobFilePath(shareId, 'manifest.json'), 'utf8');
    } catch {
      return null;
    }
  }

  async deleteShare(shareId: string): Promise<boolean> {
    if (!isSafeStorageId(shareId)) return false;
    const metaPath = this.resolveShareMetaPath(shareId);
    const blobDir = this.resolveShareBlobDir(shareId);

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
    const entries = await fsp.readdir(this.sharesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const shareId = entry.name.slice(0, -'.json'.length);
      if (!isSafeStorageId(shareId)) continue;
      const record = await this.getShare(shareId);
      if (!record || record.expiresAtMs <= nowMs) {
        const deleted = await this.deleteShare(shareId);
        if (deleted) purged++;
      }
    }
    return purged;
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
    // Cloud resources are provisioned externally via Terraform/gcloud
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
          metadata: {
            contentType: 'application/octet-stream',
            cacheControl: 'no-store',
          },
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
      .set({
        ...share,
        expireAtDate: new Date(share.expiresAtMs),
      });
  }

  async getShare(shareId: string): Promise<ShareRecord | null> {
    if (!isSafeStorageId(shareId)) return null;
    const snap = await this.firestore.collection(this.collectionName).doc(shareId).get();
    if (!snap.exists) return null;
    return snap.data() as ShareRecord;
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
    return {
      stream: file.createReadStream(),
      sizeBytes: Number(meta.size || 0),
    };
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
    const file = this.storage
      .bucket(this.bucketName)
      .file(this.blobObjectKey(shareId, 'context.md'));
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
    await this.storage
      .bucket(this.bucketName)
      .deleteFiles({ prefix: `shares/${shareId}/`, force: true });
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
      const deleted = await this.deleteShare(doc.id);
      if (deleted) purged++;
    }
    return purged;
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
