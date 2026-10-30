import { Text, View } from "@react-pdf/renderer";
import { readableOn } from "@/lib/contrast";
import { Details, InvoiceBody, InvoicePage, Logo, Party } from "../parts";
import type { InvoiceView } from "../view";
import type { DesignTokens, InvoiceDesign } from "./types";

const tokens: DesignTokens = {
  colors: { accent: "#6d28d9", surface: "#ede9fe", text: "#1e1533", line: "#d4cbef" },
  fonts: { body: "Inter", heading: "Inter", mono: "JetBrains Mono" },
  sizes: { base: 9.5, small: 8, heading: 13, title: 32 },
  spacing: { page: 36, section: 12, cell: 5 },
  lineHeight: 1.35,
  radius: 10,
  lineWidth: 0.5,
  mutedOpacity: 0.75,
  watermarkOpacity: 0.07,
  parts: { tableHeader: "surface", tableRows: "plain", totals: "band", payment: "accent" },
};

function BlokPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts, radius } = tokens;
  const logoLeft = view.logoPosition === "left" && view.images.logo !== null;
  const pad = spacing.section;
  return (
    <InvoicePage view={view} tokens={tokens}>
      <View
        style={{
          flexDirection: logoLeft ? "row" : "row-reverse",
          justifyContent: "space-between",
          alignItems: "flex-end",
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
              lineHeight: 1.05,
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
      <View style={{ flexDirection: "row", gap: spacing.section / 2 }}>
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            padding: pad,
            borderRadius: radius,
            backgroundColor: view.colors.accent,
            color: readableOn(view.colors.accent),
          }}
        >
          <Party label={view.labels.supplier} party={view.supplier} tokens={tokens} />
        </View>
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            padding: pad,
            borderRadius: radius,
            backgroundColor: view.colors.surface,
          }}
        >
          <Party label={view.labels.customer} party={view.customer} tokens={tokens} />
        </View>
      </View>
      <View
        style={{
          padding: spacing.section / 2,
          borderRadius: radius,
          borderWidth: 1,
          borderColor: view.colors.line,
        }}
      >
        <Details view={view} tokens={tokens} />
      </View>
      <InvoiceBody view={view} tokens={tokens} />
    </InvoicePage>
  );
}

export const blok: InvoiceDesign = { id: "blok", name: "Blok", tokens, Page: BlokPage };
