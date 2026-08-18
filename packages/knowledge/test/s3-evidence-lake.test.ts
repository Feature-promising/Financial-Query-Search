import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3EvidenceLake, type S3ObjectClient } from "../src/index.js";

describe("S3EvidenceLake", () => {
  it("confines reads and writes to its configured prefix", async () => {
    const client = new FakeS3Client();
    const lake = new S3EvidenceLake({ bucket: "research-evidence-bucket", region: "us-east-1", prefix: "tenant/org-1", client });
    const stored = await lake.put("filing.txt", new TextEncoder().encode("content"), { source: "SEC" });
    expect(stored.uri).toBe("s3://research-evidence-bucket/tenant/org-1/filing.txt");
    expect(await lake.get(stored.uri)).toEqual(new TextEncoder().encode("content"));
    await expect(lake.get("s3://other-bucket/object")).rejects.toThrow("outside");
  });
});

class FakeS3Client implements S3ObjectClient {
  private readonly bodies = new Map<string, Uint8Array>();
  async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
    const input = command.input;
    const key = String(input.Key);
    if (command instanceof PutObjectCommand) {
      this.bodies.set(key, input.Body as Uint8Array);
      return { VersionId: "version-1" };
    }
    if (command instanceof GetObjectCommand) {
      const content = this.bodies.get(key);
      return { Body: content ? { transformToByteArray: async () => content } : undefined };
    }
    this.bodies.delete(key);
    return {};
  }
}
