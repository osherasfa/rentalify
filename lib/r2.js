/**
 * Cloudflare R2 image storage (S3-compatible).
 *
 * Configured via env (set these as GitHub Actions secrets):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Bucket + public URL default to the project's, override with R2_BUCKET / R2_PUBLIC_BASE.
 *
 * If the credentials are absent, r2Enabled() is false and the pipeline keeps the
 * original (expiring) Facebook image URLs instead — nothing breaks.
 */
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const BUCKET = process.env.R2_BUCKET || "rentalify-images";
export const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "https://pub-6f3616047fef4f4887070a43494479e4.r2.dev").replace(/\/$/, "");

let client = null;
function getClient() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  if (!client) {
    // Accept either a bare account id ("2aab…") or the full S3 endpoint URL.
    const raw = R2_ACCOUNT_ID.trim();
    const endpoint = raw.includes("://") ? raw.replace(/\/+$/, "") : `https://${raw}.r2.cloudflarestorage.com`;
    client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
  }
  return client;
}

export const r2Enabled = () => !!getClient();

/** Upload a buffer; returns the public URL. */
export async function uploadImage(buffer, key, contentType = "image/jpeg") {
  const c = getClient();
  if (!c) throw new Error("R2 not configured");
  await c.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return `${PUBLIC_BASE}/${key}`;
}

/** Map a stored public URL back to its bucket key (or null if it isn't ours). */
export const keyFromUrl = (url) => (typeof url === "string" && url.startsWith(PUBLIC_BASE + "/") ? url.slice(PUBLIC_BASE.length + 1) : null);

/** Delete objects by key (chunked to S3's 1000-per-request limit). */
export async function deleteKeys(keys) {
  const c = getClient();
  if (!c || !keys.length) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const Objects = keys.slice(i, i + 1000).map((Key) => ({ Key }));
    await c.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects } }));
  }
}
