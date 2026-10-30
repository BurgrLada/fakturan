import { Circle, Polygon, Rect, Svg, Text, View } from "@react-pdf/renderer";
import { Details, InvoiceBody, InvoicePage, Logo, Parties } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#c2410c", surface: "#fff1e6", text: "#22150e", line: "#f0d3bd" },
  fonts: { body: "Inter", heading: "Inter", mono: "JetBrains Mono" },
  sizes: { base: 9.5, small: 8, heading: 12, title: 30 },
  spacing: { page: 42, section: 13, cell: 5 },
  lineHeight: 1.35,
  radius: 14,
  lineWidth: 0.5,
  mutedOpacity: 0.7,
  watermarkOpacity: 0.07,
  parts: { tableHeader: "surface", totals: "boxed", payment: "surface" },
};

const SHAPES_WIDTH = 210;
const SHAPES_HEIGHT = 120;

function Shapes({ view, mirrored }: { view: InvoiceView; mirrored: boolean }) {
  const { accent, surface, line } = view.colors;
  return (
    <Svg
      width={SHAPES_WIDTH}
      height={SHAPES_HEIGHT}
      viewBox={`0 0 ${SHAPES_WIDTH} ${SHAPES_HEIGHT}`}
      style={{
        position: "absolute",
        top: 0,
        ...(mirrored ? { left: 0, transform: "scaleX(-1)" } : { right: 0 }),
      }}
    >
      <Rect x={60} y={0} width={150} height={60} fill={surface} />
      <Circle cx={170} cy={36} r={36} fill={accent} />
      <Polygon points="60,0 120,0 60,60" fill={line} />
      <Circle cx={100} cy={82} r={14} fill={accent} fillOpacity={0.35} />
      <Polygon points="150,120 210,120 210,60" fill={accent} fillOpacity={0.6} />
    </Svg>
  );
}

function GeometricPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoRight = view.logoPosition === "right";
  return (
    <InvoicePage
      view={view}
      tokens={tokens}
      background={<Shapes view={view} mirrored={logoRight} />}
    >
      <View
        style={{
          gap: spacing.section / 2,
          alignItems: logoRight ? "flex-end" : "flex-start",
          paddingLeft: logoRight ? SHAPES_WIDTH - spacing.page : 0,
          paddingRight: logoRight ? 0 : SHAPES_WIDTH - spacing.page,
        }}
      >
        <Logo view={view} />
        <Text
          style={{
            fontFamily: fonts.heading,
            fontSize: sizes.title,
            fontWeight: 700,
            lineHeight: 1.1,
            color: view.colors.accent,
          }}
        >
          {view.title}
        </Text>
        {view.number ? (
          <Text style={{ fontSize: sizes.heading, fontFamily: fonts.mono }}>{view.number}</Text>
        ) : null}
      </View>
      <Parties view={view} tokens={tokens} />
      <Details view={view} tokens={tokens} />
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const geometric: InvoiceDesign = {
  id: "geometric",
  name: "Geometric",
  tokens,
  Page: GeometricPage,
};
