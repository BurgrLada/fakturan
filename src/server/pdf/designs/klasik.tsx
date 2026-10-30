import { Text, View } from "@react-pdf/renderer";
import { Details, InvoiceBody, InvoicePage, Logo, Party } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#1f2a44", surface: "#f4f2ec", text: "#17171b", line: "#b9b5a7" },
  fonts: { body: "Source Serif 4", heading: "Source Serif 4", mono: "Source Serif 4" },
  sizes: { base: 10, small: 8, heading: 12, title: 26 },
  spacing: { page: 50, section: 16, cell: 5 },
  lineHeight: 1.35,
  radius: 0,
  lineWidth: 0.5,
  mutedOpacity: 0.7,
  watermarkOpacity: 0.07,
  parts: { totals: "plain", payment: "outline" },
};

const LOGO_SLOT = 120;

function KlasikPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts, lineWidth } = tokens;
  const logoRight = view.logoPosition === "right";
  const box = {
    flex: 1,
    flexDirection: "row" as const,
    padding: spacing.section / 2,
    borderWidth: lineWidth,
    borderColor: view.colors.line,
  };
  return (
    <InvoicePage view={view} tokens={tokens}>
      <View
        style={{
          flexDirection: logoRight ? "row-reverse" : "row",
          alignItems: "center",
        }}
      >
        <View style={{ width: LOGO_SLOT, alignItems: logoRight ? "flex-end" : "flex-start" }}>
          <Logo view={view} />
        </View>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text
            style={{
              fontFamily: fonts.heading,
              fontSize: sizes.title,
              fontWeight: 700,
              lineHeight: 1.2,
              textAlign: "center",
              color: view.colors.accent,
            }}
          >
            {view.title}
          </Text>
          {view.number ? <Text style={{ fontSize: sizes.heading }}>{view.number}</Text> : null}
        </View>
        <View style={{ width: LOGO_SLOT }} />
      </View>
      <View style={{ gap: 2 }}>
        <View style={{ height: 1.5, backgroundColor: view.colors.accent }} />
        <View style={{ height: 0.5, backgroundColor: view.colors.accent }} />
      </View>
      <View style={{ flexDirection: "row", gap: spacing.section }}>
        <View style={box}>
          <Party label={view.labels.supplier} party={view.supplier} tokens={tokens} />
        </View>
        <View style={box}>
          <Party label={view.labels.customer} party={view.customer} tokens={tokens} />
        </View>
      </View>
      <Details view={view} tokens={tokens} />
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const klasik: InvoiceDesign = { id: "klasik", name: "Klasik", tokens, Page: KlasikPage };
