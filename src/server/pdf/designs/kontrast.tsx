import { Text, View } from "@react-pdf/renderer";
import { readableOn } from "@/lib/contrast";
import { Details, FullBleed, InvoiceBody, InvoicePage, Logo, Parties } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#0a0a0a", surface: "#fde047", text: "#0a0a0a", line: "#0a0a0a" },
  fonts: { body: "Inter", heading: "Inter", mono: "JetBrains Mono" },
  sizes: { base: 9.5, small: 8, heading: 13, title: 36 },
  spacing: { page: 36, section: 14, cell: 5 },
  lineHeight: 1.35,
  radius: 0,
  lineWidth: 1,
  mutedOpacity: 0.75,
  watermarkOpacity: 0.09,
  parts: { tableHeader: "filled", totals: "band", payment: "surface" },
};

function KontrastPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoRight = view.logoPosition === "right";
  return (
    <InvoicePage view={view} tokens={tokens}>
      <FullBleed tokens={tokens} backgroundColor={view.colors.accent} first>
        <View style={{ gap: spacing.cell, color: readableOn(view.colors.accent) }}>
          <View
            style={{
              flexDirection: logoRight ? "row-reverse" : "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: spacing.section,
            }}
          >
            <Logo view={view} />
            {view.number ? (
              <Text style={{ fontSize: sizes.heading, fontFamily: fonts.mono }}>{view.number}</Text>
            ) : null}
          </View>
          <Text
            style={{
              fontFamily: fonts.heading,
              fontSize: sizes.title,
              fontWeight: 700,
              lineHeight: 1.05,
              textTransform: "uppercase",
            }}
          >
            {view.title}
          </Text>
        </View>
      </FullBleed>
      <FullBleed tokens={tokens} backgroundColor={view.colors.surface}>
        <Details view={view} tokens={tokens} />
      </FullBleed>
      <Parties view={view} tokens={tokens} />
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const kontrast: InvoiceDesign = {
  id: "kontrast",
  name: "Kontrast",
  tokens,
  Page: KontrastPage,
};
