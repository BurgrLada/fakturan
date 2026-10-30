import { Text, View } from "@react-pdf/renderer";
import { InvoiceBody, InvoicePage, Logo, Parties } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#166534", surface: "#f0f5f0", text: "#14211a", line: "#8aa394" },
  fonts: { body: "JetBrains Mono", heading: "JetBrains Mono", mono: "JetBrains Mono" },
  sizes: { base: 8.5, small: 7, heading: 11, title: 22 },
  spacing: { page: 40, section: 16, cell: 4 },
  lineHeight: 1.4,
  radius: 0,
  lineWidth: 0.75,
  mutedOpacity: 0.7,
  watermarkOpacity: 0.07,
  parts: { totals: "plain", payment: "outline", lineStyle: "dashed" },
};

function MonoPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoLeft = view.logoPosition === "left" && view.images.logo !== null;
  return (
    <InvoicePage view={view} tokens={tokens}>
      <View
        style={{
          flexDirection: logoLeft ? "row" : "row-reverse",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: spacing.section,
          paddingBottom: spacing.section / 2,
          borderBottomWidth: tokens.lineWidth,
          borderBottomColor: view.colors.accent,
          borderBottomStyle: "dashed",
        }}
      >
        <Logo view={view} />
        <View style={{ flex: 1, alignItems: logoLeft ? "flex-end" : "flex-start" }}>
          <Text
            style={{
              fontFamily: fonts.heading,
              fontSize: sizes.title,
              fontWeight: 700,
              lineHeight: 1.2,
              color: view.colors.accent,
            }}
          >
            {view.number ? `${view.title} #${view.number}` : view.title}
          </Text>
        </View>
      </View>
      <Parties view={view} tokens={tokens} />
      <View style={{ gap: 1 }}>
        {view.details.map((row) => (
          <View key={row.label} style={{ flexDirection: "row", gap: spacing.cell }}>
            <Text style={{ width: 130, opacity: tokens.mutedOpacity }}>{row.label}</Text>
            <Text style={{ flex: 1 }}>{row.value}</Text>
          </View>
        ))}
      </View>
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const mono: InvoiceDesign = { id: "mono", name: "Mono", tokens, Page: MonoPage };
