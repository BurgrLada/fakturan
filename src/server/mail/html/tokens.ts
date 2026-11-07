// The only place with the e-mail's colours and type. A mail client inherits nothing from the app's
// theme, so these are literal values, deliberately neutral (docs/superpowers/mockups/email-sablony.html).
export const COLORS = {
  page: "#eceef0",
  card: "#ffffff",
  ink: "#20252b",
  soft: "#626b75",
  rule: "#dfe3e7",
  tint: "#f4f5f6",
} as const;

export const NEUTRAL_BAND = "#2b3440";

export const WIDTH = 600;

const FONT = "Arial,Helvetica,sans-serif";

export const SIZES = {
  pagePadding: "24px 12px",
  cardPadding: "22px",
  bandPadding: "18px 22px",
  tintPadding: "16px",
  radius: "8px",
  logoHeight: 40,
  plate: { padding: "6px 10px", radius: "6px" },
  logoMaxWidth: 240,
  rule: { width: 56, height: 3 },
  qr: { b2: 112, b3: 104, b5: 132 },
} as const;

export const TYPE = {
  base: `font-family:${FONT};font-size:15px;line-height:1.55;color:${COLORS.ink}`,
  paragraph: `margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:1.55;color:${COLORS.ink}`,
  signature: `margin:0 0 12px;font-family:${FONT};font-size:13px;line-height:1.55;color:${COLORS.soft}`,
  small: `font-size:13px;line-height:1.5;color:${COLORS.soft}`,
  foot: `font-family:${FONT};font-size:12px;line-height:1.5;color:${COLORS.soft}`,
  name: `font-size:17px;font-weight:700;letter-spacing:-0.01em;line-height:1.3`,
  amount: `font-size:30px;font-weight:700;line-height:1.15;color:${COLORS.ink}`,
  rows: `font-family:${FONT};font-size:14px;line-height:1.5;color:${COLORS.ink}`,
  tag: `display:inline-block;font-size:12px;font-weight:700;background-color:${COLORS.tint};border-radius:4px;padding:2px 8px;color:${COLORS.ink}`,
  chip: `display:inline-block;font-size:13px;color:${COLORS.soft};border:1px solid ${COLORS.rule};border-radius:6px;padding:6px 10px;margin-top:4px`,
} as const;
