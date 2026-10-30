import "server-only";
import sharp from "sharp";

const MAX_WIDTH = 800;
const SVG_DENSITY = 216;

// react-pdf reads neither WebP nor SVG. The input must already be a stored, sanitized file.
export async function imageToPng(data: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(data, { density: SVG_DENSITY })
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .toColourspace("srgb")
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}
