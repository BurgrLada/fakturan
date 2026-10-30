import { Page, Text, View } from "@react-pdf/renderer";
import {
  Details,
  FooterText,
  LinesTable,
  Logo,
  Parties,
  PageNumber,
  PaymentBox,
  Signature,
  TextBlock,
  Totals,
  Watermark,
} from "../parts";
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

const FOOTER_SPACE = 78;

function CistyPage({ view }: { view: InvoiceView }) {
  const { spacing, sizes, fonts } = tokens;
  const logoRight = view.logoPosition === "right";
  return (
    <Page
      size="A4"
      style={{
        fontFamily: fonts.body,
        fontSize: sizes.base,
        color: view.colors.text,
        paddingTop: spacing.page,
        paddingHorizontal: spacing.page,
        paddingBottom: FOOTER_SPACE,
      }}
    >
      <Watermark view={view} tokens={tokens} />
      <View style={{ gap: spacing.section, fontSize: sizes.base, lineHeight: tokens.lineHeight }}>
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
        <TextBlock text={view.textBefore} tokens={tokens} />
        <LinesTable view={view} tokens={tokens} />
        <Totals view={view} tokens={tokens} />
        <TextBlock text={view.textAfter} tokens={tokens} />
        <PaymentBox view={view} tokens={tokens} />
        <TextBlock text={view.note} label={view.labels.note} tokens={tokens} />
        <TextBlock text={view.vatStatement} tokens={tokens} />
        <TextBlock text={view.registryNote} tokens={tokens} />
        <Signature view={view} tokens={tokens} />
      </View>
      <FooterText view={view} tokens={tokens} />
      <PageNumber view={view} tokens={tokens} />
    </Page>
  );
}

export const cisty: InvoiceDesign = { id: "cisty", name: "Čistý", tokens, Page: CistyPage };
