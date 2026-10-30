import { Text, View } from "@react-pdf/renderer";
import { Details, InvoiceBody, InvoicePage, Logo, Parties } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#1f2937", surface: "#f3f4f6", text: "#111827", line: "#d1d5db" },
  fonts: { body: "Inter", heading: "Inter", mono: "JetBrains Mono" },
  sizes: { base: 9.5, small: 8, heading: 12, title: 24 },
  spacing: { page: 42, section: 18, cell: 5 },
  lineHeight: 1.35,
  radius: 4,
  lineWidth: 0.5,
  mutedOpacity: 0.65,
  watermarkOpacity: 0.07,
};

function CistyPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoRight = view.logoPosition === "right";
  return (
    <InvoicePage view={view} tokens={tokens}>
      <View
        style={{
          flexDirection: logoRight ? "row-reverse" : "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: spacing.section,
        }}
      >
        <Logo view={view} />
        <View style={{ flex: 1, alignItems: logoRight ? "flex-start" : "flex-end" }}>
          <Text
            style={{
              fontFamily: fonts.heading,
              fontSize: sizes.title,
              fontWeight: 700,
              lineHeight: 1.2,
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
      <Parties view={view} tokens={tokens} />
      <Details view={view} tokens={tokens} />
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const cisty: InvoiceDesign = { id: "cisty", name: "Čistý", tokens, Page: CistyPage };
