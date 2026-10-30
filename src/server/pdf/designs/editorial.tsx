import { Text, View } from "@react-pdf/renderer";
import { InvoiceBody, InvoicePage, Logo, Muted, Parties } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#7c2d12", surface: "#f6f1e7", text: "#1c1917", line: "#d6cfc1" },
  fonts: { body: "Source Serif 4", heading: "Source Serif 4", mono: "JetBrains Mono" },
  sizes: { base: 10, small: 8, heading: 13, title: 36 },
  spacing: { page: 44, section: 14, cell: 5 },
  lineHeight: 1.4,
  radius: 0,
  lineWidth: 0.5,
  mutedOpacity: 0.7,
  watermarkOpacity: 0.07,
  parts: { totals: "plain", payment: "rule" },
};

const SIDEBAR_WIDTH = 132;

function EditorialPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoRight = view.logoPosition === "right";
  return (
    <InvoicePage view={view} tokens={tokens}>
      <View
        style={{
          flexDirection: logoRight ? "row-reverse" : "row",
          justifyContent: "space-between",
          alignItems: "center",
          minHeight: 20,
        }}
      >
        <Logo view={view} />
        {view.number ? <Text style={{ fontFamily: fonts.mono }}>{view.number}</Text> : null}
      </View>
      <View
        style={{
          borderTopWidth: 2,
          borderTopColor: view.colors.accent,
          borderBottomWidth: tokens.lineWidth,
          borderBottomColor: view.colors.line,
          paddingVertical: spacing.section / 2,
        }}
      >
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
      </View>
      <View style={{ flexDirection: "row", gap: spacing.section }}>
        <View style={{ width: SIDEBAR_WIDTH, gap: spacing.cell }}>
          {view.details.map((row) => (
            <View key={row.label}>
              <Muted tokens={tokens}>{row.label}</Muted>
              <Text style={{ fontWeight: 700 }}>{row.value}</Text>
            </View>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <Parties view={view} tokens={tokens} />
        </View>
      </View>
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const editorial: InvoiceDesign = {
  id: "editorial",
  name: "Editorial",
  tokens,
  Page: EditorialPage,
};
