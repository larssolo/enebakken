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

export async function presignPut(key: string, contentType: string): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(s3, cmd, { expiresIn: 300 });
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

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
