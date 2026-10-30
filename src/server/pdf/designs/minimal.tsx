import { Text, View } from "@react-pdf/renderer";
import { Details, InvoiceBody, InvoicePage, Logo, Parties } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#3f3f46", surface: "#fafafa", text: "#27272a", line: "#e4e4e7" },
  fonts: { body: "Inter", heading: "Inter", mono: "Inter" },
  sizes: { base: 9, small: 7.5, heading: 11, title: 11 },
  spacing: { page: 56, section: 18, cell: 5 },
  lineHeight: 1.45,
  radius: 0,
  lineWidth: 0.25,
  mutedOpacity: 0.6,
  watermarkOpacity: 0.05,
  parts: { tableRows: "plain", totals: "plain", payment: "rule" },
};

function MinimalPage({ view }: { view: InvoiceView }) {
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
          marginBottom: spacing.section,
        }}
      >
        <Logo view={view} />
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            justifyContent: logoRight ? "flex-start" : "flex-end",
            gap: spacing.cell,
          }}
        >
          <Text style={{ fontFamily: fonts.heading, fontSize: sizes.title, fontWeight: 700 }}>
            {view.title}
          </Text>
          {view.number ? (
            <Text style={{ fontSize: sizes.title, opacity: tokens.mutedOpacity }}>
              {view.number}
            </Text>
          ) : null}
        </View>
      </View>
      <Parties view={view} tokens={tokens} />
      <Details view={view} tokens={tokens} />
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const minimal: InvoiceDesign = {
  id: "minimal",
  name: "Minimal",
  tokens,
  Page: MinimalPage,
};
