import "server-only";
import QRCode from "qrcode";
import sharp from "sharp";

const SIZE = 1024;
const MARGIN_MODULES = 4;
const LOGO_MAX_SHARE = 0.2;
const LOGO_PADDING = 6;

export async function qrPng(payload: string, logo: Buffer | null): Promise<Buffer> {
  const options = { errorCorrectionLevel: "H", margin: MARGIN_MODULES } as const;
  const code = await QRCode.toBuffer(payload, { ...options, width: SIZE });
  if (!logo) return code;
  const modules = QRCode.create(payload, options).modules.size;
  const codeSide = (SIZE * modules) / (modules + 2 * MARGIN_MODULES);
  const box = Math.floor(codeSide * LOGO_MAX_SHARE);
  const inner = box - 2 * LOGO_PADDING;
  const padded = await sharp(logo)
    .resize(inner, inner, { fit: "inside" })
    .flatten({ background: "#ffffff" })
    .extend({
      top: LOGO_PADDING,
      bottom: LOGO_PADDING,
      left: LOGO_PADDING,
      right: LOGO_PADDING,
      background: "#ffffff",
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  return sharp(code)
    .composite([
      {
        input: padded.data,
        left: Math.round((SIZE - padded.info.width) / 2),
        top: Math.round((SIZE - padded.info.height) / 2),
      },
    ])
    .png()
    .toBuffer();
}
