export const MIN_TEXT_CONTRAST = 4.5;

const LIGHT = "#ffffff";
const DARK = "#000000";

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const channel = (start: number) => linear(Number.parseInt(hex.slice(start, start + 2), 16));
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// WCAG 2 contrast ratio, from 1 to 21.
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

// Pure black or white always reaches at least 4.58:1, so custom colours stay legible.
export function readableOn(background: string): string {
  return contrastRatio(background, LIGHT) >= contrastRatio(background, DARK) ? LIGHT : DARK;
}
