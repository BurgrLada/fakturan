import { Text, View } from "@react-pdf/renderer";
import { readableOn } from "@/lib/contrast";
import { FullBleed, InvoiceBody, InvoicePage, Logo, Muted, Parties } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#0f766e", surface: "#e6f4f1", text: "#10201e", line: "#c5dcd7" },
  fonts: { body: "Inter", heading: "Inter", mono: "JetBrains Mono" },
  sizes: { base: 9.5, small: 8, heading: 13, title: 30 },
  spacing: { page: 42, section: 18, cell: 5 },
  lineHeight: 1.35,
  radius: 3,
  lineWidth: 0.5,
  mutedOpacity: 0.7,
  watermarkOpacity: 0.07,
  parts: { tableHeader: "filled", tableRows: "zebra", totals: "band", payment: "surface" },
};

function BarevnyPasPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoLeft = view.logoPosition === "left" && view.images.logo !== null;
  const onAccent = readableOn(view.colors.accent);
  return (
    <InvoicePage view={view} tokens={tokens}>
      <FullBleed tokens={tokens} backgroundColor={view.colors.accent} first>
        <View
          style={{
            flexDirection: logoLeft ? "row" : "row-reverse",
            justifyContent: "space-between",
            alignItems: "center",
            gap: spacing.section,
            color: onAccent,
          }}
        >
          <Logo view={view} />
          <View style={{ flex: 1, alignItems: logoLeft ? "flex-end" : "flex-start" }}>
            <Text
              style={{
                fontFamily: fonts.heading,
                fontSize: sizes.title,
                fontWeight: 700,
                lineHeight: 1.15,
              }}
            >
              {view.title}
            </Text>
            {view.number ? (
              <Text style={{ fontSize: sizes.heading, fontFamily: fonts.mono }}>{view.number}</Text>
            ) : null}
          </View>
        </View>
      </FullBleed>
      <FullBleed tokens={tokens} backgroundColor={view.colors.surface}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.section }}>
          {view.details.map((row) => (
            <View key={row.label}>
              <Muted tokens={tokens}>{row.label}</Muted>
              <Text style={{ fontWeight: 700 }}>{row.value}</Text>
            </View>
          ))}
        </View>
      </FullBleed>
      <Parties view={view} tokens={tokens} />
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const barevnyPas: InvoiceDesign = {
  id: "barevny-pas",
  name: "Barevný pás",
  tokens,
  Page: BarevnyPasPage,
};
