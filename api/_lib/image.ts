import sharp from "sharp";

export const MAX_EDGE = 1000;

// Well above any phone camera (48 MP), well below a decompression bomb.
const MAX_INPUT_PIXELS = 60_000_000;

export class NotAnImageError extends Error {}

// The file's own first bytes must say it's the format it was uploaded as.
// Nothing else reaches the decoder: formats like SVG, HEIF or TIFF, which
// sharp would otherwise happily try to parse, never get that far.
function sniff(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

// Every upload is decoded and re-encoded, whatever the browser already did:
// that holds the 1000px limit even for a client that skips the in-browser
// resize, applies the EXIF rotation, and drops all metadata (phone photos
// carry GPS coordinates) and colour profiles (converted to sRGB).
export async function normalizeImage(input: Buffer, contentType: string): Promise<{ data: Buffer; width: number; height: number }> {
  if (sniff(input) !== contentType) throw new NotAnImageError("content does not match the declared image type");

  const animated = contentType === "image/gif" || contentType === "image/webp";
  let pipeline = sharp(input, { animated, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true });

  if (contentType === "image/jpeg") pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
  else if (contentType === "image/png") pipeline = pipeline.png({ compressionLevel: 9 });
  else if (contentType === "image/webp") pipeline = pipeline.webp({ quality: 82 });
  else pipeline = pipeline.gif();

  try {
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.pageHeight ?? info.height };
  } catch (e) {
    throw new NotAnImageError(e instanceof Error ? e.message : String(e));
  }
}
