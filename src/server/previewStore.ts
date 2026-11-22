import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { PreviewSessionRecord } from '../shared/types.ts';
import { isSafeStorageId } from './storage.ts';

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function timingSafeHexEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export type PreviewLookupResult =
  | { ok: true; record: PreviewSessionRecord }
  | { ok: false; reason: 'not_found' | 'unauthorized' | 'expired' };

export class PreviewStore {
  private readonly baseDir: string;

  constructor(previewDir: string) {
    this.baseDir = path.resolve(previewDir);
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
  }

  private resolvePreviewDir(previewId: string): string {
    if (!isSafeStorageId(previewId)) {
      throw new Error('Invalid preview identifier.');
    }
    const target = path.resolve(this.baseDir, previewId);
    if (!target.startsWith(this.baseDir + path.sep)) {
      throw new Error('Path confinement violation on preview directory.');
    }
    return target;
  }

  private resolveBlobPath(previewId: string, fileId: string): string {
    if (!isSafeStorageId(fileId)) {
      throw new Error('Invalid preview file identifier.');
    }
    const previewDir = this.resolvePreviewDir(previewId);
    const blobsDir = path.resolve(previewDir, 'blobs');
    const target = path.resolve(blobsDir, fileId);
    if (!target.startsWith(blobsDir + path.sep)) {
      throw new Error('Path confinement violation on preview blob.');
    }
    return target;
  }

  async savePreview(params: {
    record: PreviewSessionRecord;
    blobTempPaths: Map<string, string>;
  }): Promise<void> {
    const { record, blobTempPaths } = params;
    await this.init();

    const previewDir = this.resolvePreviewDir(record.previewId);
    const blobsDir = path.resolve(previewDir, 'blobs');
    await fsp.mkdir(blobsDir, { recursive: true });

    try {
      for (const [fileId, tempPath] of blobTempPaths.entries()) {
        const destPath = this.resolveBlobPath(record.previewId, fileId);
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

      const metaPath = path.resolve(previewDir, 'meta.json');
      const tmpMeta = `${metaPath}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmpMeta, JSON.stringify(record, null, 2), 'utf8');
      await fsp.rename(tmpMeta, metaPath);
    } catch (err) {
      await fsp.rm(previewDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async readMeta(previewId: string): Promise<PreviewSessionRecord | null> {
    if (!isSafeStorageId(previewId)) return null;
    try {
      const previewDir = this.resolvePreviewDir(previewId);
      const raw = await fsp.readFile(path.resolve(previewDir, 'meta.json'), 'utf8');
      return JSON.parse(raw) as PreviewSessionRecord;
    } catch {
      return null;
    }
  }

  async getPreviewForOwner(
    previewId: string,
    ownerToken: string,
    nowMs: number = Date.now(),
  ): Promise<PreviewLookupResult> {
    const record = await this.readMeta(previewId);
    if (!record) return { ok: false, reason: 'not_found' };

    if (!ownerToken || !timingSafeHexEqual(sha256Hex(ownerToken), record.ownerTokenHash)) {
      return { ok: false, reason: 'unauthorized' };
    }

    if (record.expiresAtMs <= nowMs) {
      await this.deletePreview(previewId).catch(() => undefined);
      return { ok: false, reason: 'expired' };
    }

    return { ok: true, record };
  }

  async getPreviewForSiteAccess(
    previewId: string,
    siteAccessToken: string,
    nowMs: number = Date.now(),
  ): Promise<PreviewLookupResult> {
    const record = await this.readMeta(previewId);
    if (!record) return { ok: false, reason: 'not_found' };

    if (
      !siteAccessToken ||
      !timingSafeHexEqual(sha256Hex(siteAccessToken), record.siteAccessTokenHash)
    ) {
      return { ok: false, reason: 'unauthorized' };
    }

    if (record.expiresAtMs <= nowMs) {
      await this.deletePreview(previewId).catch(() => undefined);
      return { ok: false, reason: 'expired' };
    }

    return { ok: true, record };
  }

  async readHtmlText(previewId: string, fileId: string): Promise<string | null> {
    try {
      const filePath = this.resolveBlobPath(previewId, fileId);
      return await fsp.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  async openAssetStream(
    previewId: string,
    fileId: string,
  ): Promise<{ stream: Readable; sizeBytes: number } | null> {
    try {
      const filePath = this.resolveBlobPath(previewId, fileId);
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

  async deletePreview(previewId: string): Promise<boolean> {
    if (!isSafeStorageId(previewId)) return false;
    try {
      const previewDir = this.resolvePreviewDir(previewId);
      const existed = await fsp
        .stat(previewDir)
        .then(() => true)
        .catch(() => false);
      await fsp.rm(previewDir, { recursive: true, force: true });
      return existed;
    } catch {
      return false;
    }
  }

  async purgeExpiredPreviews(nowMs: number = Date.now()): Promise<number> {
    await this.init();
    let purged = 0;
    const entries = await fsp.readdir(this.baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isSafeStorageId(entry.name)) {
        await fsp
          .rm(path.resolve(this.baseDir, entry.name), { recursive: true, force: true })
          .catch(() => undefined);
        continue;
      }
      const meta = await this.readMeta(entry.name);
      if (!meta || meta.expiresAtMs <= nowMs) {
        const deleted = await this.deletePreview(entry.name);
        if (deleted) purged++;
      }
    }
    return purged;
  }
}
