import { Text, View } from "@react-pdf/renderer";
import { Details, InvoiceBody, InvoicePage, Logo, Parties } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const STRIPE_WIDTH = 30;

const tokens: DesignTokens = {
  colors: { accent: "#be123c", surface: "#fff1f3", text: "#1f1317", line: "#f3cdd5" },
  fonts: { body: "Inter", heading: "Inter", mono: "JetBrains Mono" },
  sizes: { base: 9.5, small: 8, heading: 12, title: 28 },
  spacing: { page: 36, section: 18, cell: 5, sideInset: STRIPE_WIDTH },
  lineHeight: 1.35,
  radius: 3,
  lineWidth: 0.5,
  mutedOpacity: 0.7,
  watermarkOpacity: 0.07,
  parts: { tableRows: "zebra", totals: "boxed", payment: "surface" },
};

// Fixed and first among the page's children, so every page paints it under the text.
function Stripe({ view }: { view: InvoiceView }) {
  return (
    <View
      fixed
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        width: STRIPE_WIDTH,
        backgroundColor: view.colors.accent,
      }}
    />
  );
}

function BocniPruhPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoLeft = view.logoPosition === "left" && view.images.logo !== null;
  return (
    <InvoicePage view={view} tokens={tokens} background={<Stripe view={view} />}>
      <View
        style={{
          flexDirection: logoLeft ? "row" : "row-reverse",
          justifyContent: "space-between",
          alignItems: "center",
          gap: spacing.section,
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

export const bocniPruh: InvoiceDesign = {
  id: "bocni-pruh",
  name: "Boční pruh",
  tokens,
  Page: BocniPruhPage,
};
