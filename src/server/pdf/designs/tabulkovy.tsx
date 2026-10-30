import { Text, View } from "@react-pdf/renderer";
import { InvoiceBody, InvoicePage, Logo, Muted, Party } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#1e3a5f", surface: "#eaf0f6", text: "#14202e", line: "#9fb1c4" },
  fonts: { body: "Inter", heading: "Inter", mono: "JetBrains Mono" },
  sizes: { base: 9, small: 7.5, heading: 12, title: 20 },
  spacing: { page: 36, section: 14, cell: 5 },
  lineHeight: 1.3,
  radius: 0,
  lineWidth: 0.75,
  mutedOpacity: 0.7,
  watermarkOpacity: 0.07,
  parts: { tableHeader: "surface", tableRows: "grid", totals: "boxed", payment: "outline" },
};

function TabulkovyPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts, lineWidth } = tokens;
  const logoRight = view.logoPosition === "right";
  const edge = { borderWidth: lineWidth, borderColor: view.colors.line };
  const pad = spacing.cell + 1;
  return (
    <InvoicePage view={view} tokens={tokens}>
      <View>
        <View
          style={{
            ...edge,
            flexDirection: logoRight ? "row-reverse" : "row",
            justifyContent: "space-between",
            alignItems: "center",
            gap: spacing.section,
            padding: pad,
            backgroundColor: view.colors.surface,
          }}
        >
          <Logo view={view} />
          <View
            style={{
              flex: 1,
              flexDirection: logoRight ? "row" : "row-reverse",
              justifyContent: "space-between",
              alignItems: "center",
              gap: spacing.section,
            }}
          >
            <Text
              style={{
                fontFamily: fonts.heading,
                fontSize: sizes.title,
                fontWeight: 700,
                color: view.colors.accent,
              }}
            >
              {view.title}
            </Text>
            {view.number ? (
              <Text style={{ fontFamily: fonts.mono, fontSize: sizes.heading }}>{view.number}</Text>
            ) : null}
          </View>
        </View>
        <View style={{ ...edge, borderTopWidth: 0, flexDirection: "row" }}>
          <View style={{ flex: 1, flexDirection: "row", padding: pad }}>
            <Party label={view.labels.supplier} party={view.supplier} tokens={tokens} />
          </View>
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              padding: pad,
              borderLeftWidth: lineWidth,
              borderLeftColor: view.colors.line,
            }}
          >
            <Party label={view.labels.customer} party={view.customer} tokens={tokens} />
          </View>
        </View>
        <View style={{ ...edge, borderTopWidth: 0, flexDirection: "row" }}>
          {view.details.map((row, index) => (
            <View
              key={row.label}
              style={{
                flex: 1,
                padding: pad,
                borderLeftWidth: index === 0 ? 0 : lineWidth,
                borderLeftColor: view.colors.line,
              }}
            >
              <Muted tokens={tokens}>{row.label}</Muted>
              <Text style={{ fontWeight: 700 }}>{row.value}</Text>
            </View>
          ))}
        </View>
      </View>
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const tabulkovy: InvoiceDesign = {
  id: "tabulkovy",
  name: "Tabulkový",
  tokens,
  Page: TabulkovyPage,
};
