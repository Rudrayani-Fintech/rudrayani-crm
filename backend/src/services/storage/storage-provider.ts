import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

/**
 * File storage abstraction (confirmed decision: local disk in dev, behind an
 * interface so an S3-compatible provider is a config change at deploy time).
 * Keys look like "imports/<uuid>.xlsx" — no client-supplied path parts.
 */
export interface StorageProvider {
  save(prefix: string, extension: string, data: Buffer): Promise<string>;
  read(key: string): Promise<Buffer>;
  /**
   * Best-effort cleanup for a key whose DB row never committed (e.g. a
   * payment/field-visit/attachment transaction that rolled back after the
   * file was already written). Callers should not let a delete failure mask
   * the original error -- swallow and log, don't rethrow.
   */
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9_-]+\/[a-f0-9-]+\.[a-z0-9]+$/;

export class LocalDiskStorage implements StorageProvider {
  constructor(private readonly rootDir: string) {}

  async save(prefix: string, extension: string, data: Buffer): Promise<string> {
    const key = `${prefix}/${crypto.randomUUID()}.${extension.replace(/^\./, "")}`;
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid storage key: ${key}`);
    const fullPath = path.join(this.rootDir, key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
    return key;
  }

  async read(key: string): Promise<Buffer> {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return fs.readFile(path.join(this.rootDir, key));
  }

  async delete(key: string): Promise<void> {
    if (!KEY_PATTERN.test(key)) return;
    try {
      await fs.unlink(path.join(this.rootDir, key));
    } catch {
      // Already gone -- nothing to clean up.
    }
  }
}

/**
 * S3-compatible storage (Cloudflare R2, or any S3 provider). Most hosted
 * platforms (Render, Fly, Vercel) wipe or don't persist local disk across
 * deploys/restarts, so uploads (payment photos, import spreadsheets) need to
 * live somewhere durable once the backend isn't running on your own machine.
 */
export class S3CompatibleStorage implements StorageProvider {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    endpoint: string,
    accessKeyId: string,
    secretAccessKey: string,
  ) {
    this.client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async save(prefix: string, extension: string, data: Buffer): Promise<string> {
    const key = `${prefix}/${crypto.randomUUID()}.${extension.replace(/^\./, "")}`;
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid storage key: ${key}`);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }),
    );
    return key;
  }

  async read(key: string): Promise<Buffer> {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid storage key: ${key}`);
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    if (!KEY_PATTERN.test(key)) return;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      // Already gone, or the delete itself failed -- not worth failing the
      // request over an orphaned object; nothing downstream references it.
    }
  }
}

let provider: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  if (!provider) {
    const hasR2Config = env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET;
    if (!hasR2Config && env.NODE_ENV === "production") {
      // Render (and most hosted platforms) wipe or don't persist local disk
      // across deploys/restarts -- silently falling back to LocalDiskStorage
      // here meant every payment photo, signature, and import file uploaded
      // since the last deploy was gone on the next one, with nothing in the
      // logs to explain why until someone noticed a missing photo.
      logger.warn(
        "R2 storage is not configured (R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET) " +
          "but NODE_ENV=production -- falling back to local disk storage, which does NOT survive a redeploy " +
          "on Render. Uploaded files (payment photos, signatures, import spreadsheets) will be lost on the next deploy.",
      );
    }
    provider =
      env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
        ? new S3CompatibleStorage(
            env.R2_BUCKET,
            env.R2_ENDPOINT,
            env.R2_ACCESS_KEY_ID,
            env.R2_SECRET_ACCESS_KEY,
          )
        : new LocalDiskStorage(env.UPLOAD_DIR);
  }
  return provider;
}
