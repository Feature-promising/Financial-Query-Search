import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { EvidenceLake } from "../types.js";

export interface S3ObjectClient {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<{ VersionId?: string; Body?: { transformToByteArray(): Promise<Uint8Array> } }>;
}

/** S3 evidence lake with bucket/prefix confinement; arbitrary S3 URIs are rejected. */
export class S3EvidenceLake implements EvidenceLake {
  private readonly client: S3ObjectClient;
  private readonly prefix: string;

  constructor(options: { bucket: string; region: string; prefix?: string; client?: S3ObjectClient }) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error("invalid evidence bucket");
    this.bucket = options.bucket;
    this.prefix = normalizePrefix(options.prefix ?? "evidence/");
    this.client = options.client ?? new S3Client({ region: options.region });
  }

  private readonly bucket: string;

  async put(key: string, body: Uint8Array, metadata: Record<string, string>): Promise<{ uri: string; versionId: string }> {
    const objectKey = this.toObjectKey(key);
    const result = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: body, Metadata: sanitizeMetadata(metadata) }));
    if (!result.VersionId) throw new Error("evidence bucket must enable object versioning");
    return { uri: `s3://${this.bucket}/${objectKey}`, versionId: result.VersionId };
  }

  async get(uri: string): Promise<Uint8Array> {
    const key = this.fromUri(uri);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error("evidence object has no body");
    return result.Body.transformToByteArray();
  }

  async delete(uri: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fromUri(uri) }));
  }

  private toObjectKey(key: string): string {
    if (!key || key.includes("..") || key.startsWith("/") || key.includes("\\")) throw new Error("invalid evidence key");
    return `${this.prefix}${key}`;
  }

  private fromUri(uri: string): string {
    const expected = `s3://${this.bucket}/${this.prefix}`;
    if (!uri.startsWith(expected)) throw new Error("evidence URI is outside the configured bucket and prefix");
    const key = uri.slice(`s3://${this.bucket}/`.length);
    if (!key || key.includes("..")) throw new Error("invalid evidence URI");
    return key;
  }
}

function normalizePrefix(prefix: string): string {
  if (!prefix || prefix.startsWith("/") || prefix.includes("..") || prefix.includes("\\")) throw new Error("invalid evidence prefix");
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function sanitizeMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).filter(([key, value]) => /^[a-z0-9-]{1,64}$/i.test(key) && value.length <= 2_000));
}
