import { Text, View } from "@react-pdf/renderer";
import { InvoiceBody, InvoicePage, Logo, Muted, Party } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#1d4ed8", surface: "#eef2fb", text: "#111827", line: "#cfd8ea" },
  fonts: { body: "Inter", heading: "Inter", mono: "JetBrains Mono" },
  sizes: { base: 8, small: 7, heading: 10, title: 16 },
  spacing: { page: 28, section: 9, cell: 3 },
  lineHeight: 1.3,
  radius: 2,
  lineWidth: 0.5,
  mutedOpacity: 0.65,
  watermarkOpacity: 0.07,
  parts: { tableHeader: "surface", totals: "plain", payment: "surface" },
};

function KompaktniPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoLeft = view.logoPosition === "left" && view.images.logo !== null;
  return (
    <InvoicePage view={view} tokens={tokens}>
      <View
        style={{
          flexDirection: logoLeft ? "row" : "row-reverse",
          justifyContent: "space-between",
          alignItems: "center",
          gap: spacing.section,
          paddingBottom: spacing.cell * 2,
          borderBottomWidth: 1.5,
          borderBottomColor: view.colors.accent,
        }}
      >
        <Logo view={view} />
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            justifyContent: logoLeft ? "flex-end" : "flex-start",
            alignItems: "center",
            gap: spacing.section,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.heading,
              fontSize: sizes.title,
              fontWeight: 700,
              lineHeight: 1.25,
              color: view.colors.accent,
            }}
          >
            {view.title}
          </Text>
          {view.number ? (
            <Text style={{ fontSize: sizes.heading, fontFamily: fonts.mono }}>{view.number}</Text>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: spacing.section }}>
        <View style={{ flex: 3, flexDirection: "row" }}>
          <Party label={view.labels.supplier} party={view.supplier} tokens={tokens} />
        </View>
        <View style={{ flex: 3, flexDirection: "row" }}>
          <Party label={view.labels.customer} party={view.customer} tokens={tokens} />
        </View>
        <View style={{ flex: 2, gap: 1 }}>
          {view.details.map((row) => (
            <View key={row.label}>
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

export const kompaktni: InvoiceDesign = {
  id: "kompaktni",
  name: "Kompaktní",
  tokens,
  Page: KompaktniPage,
};
