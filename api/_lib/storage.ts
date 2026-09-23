import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = "upload";

const s3 = new S3Client({
  endpoint: process.env.AWS_ENDPOINT_URL_S3!,
  region: process.env.AWS_REGION!,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Size and type are part of the signature, so storage itself rejects an
// upload that isn't exactly what was approved — not just the browser.
export async function presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, ContentLength: contentLength });
  return getSignedUrl(s3, cmd, { expiresIn: 300, signableHeaders: new Set(["content-length", "content-type"]) });
}

export async function headObject(key: string): Promise<{ size: number } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { size: res.ContentLength ?? 0 };
  } catch {
    return null;
  }
}

export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

// Signed against the start of a fixed 6-hour window and valid for 12h, so
// every request in the same window gets the identical URL (the browser can
// reuse its cached copy instead of re-downloading the image on each visit),
// and any URL handed out stays valid for at least 6h — long enough for a
// lazily loaded image requested well after the list was fetched.
const GET_WINDOW_MS = 6 * 60 * 60 * 1000;

export async function presignGet(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const signingDate = new Date(Math.floor(Date.now() / GET_WINDOW_MS) * GET_WINDOW_MS);
  return getSignedUrl(s3, cmd, { signingDate, expiresIn: (2 * GET_WINDOW_MS) / 1000 });
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
