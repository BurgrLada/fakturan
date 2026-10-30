import { Image, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { DesignTokens } from "./designs/types";
import type { InvoiceView, LabeledValue, LineView, PartyView } from "./view";

type PartProps = { view: InvoiceView; tokens: DesignTokens };

const QR_SIZE = 96;
const LOGO_MAX_WIDTH = 150;
const LOGO_MAX_HEIGHT = 56;
const SIGNATURE_MAX_WIDTH = 140;
const SIGNATURE_MAX_HEIGHT = 56;
const FOOTER_BOTTOM = 22;
const TOTALS_WIDTH = "50%";
const COLUMNS = { quantity: 62, unitPrice: 78, discount: 52, total: 84 };

function Muted({ tokens, children }: { tokens: DesignTokens; children: string }) {
  return (
    <Text style={{ fontSize: tokens.sizes.small, opacity: tokens.mutedOpacity }}>{children}</Text>
  );
}

function Png({ data, maxWidth, maxHeight }: { data: Buffer; maxWidth: number; maxHeight: number }) {
  return (
    <Image
      src={{ data, format: "png" }}
      cache={false}
      style={{ maxWidth, maxHeight, objectFit: "contain" }}
    />
  );
}

export function Logo({ view }: { view: InvoiceView }) {
  if (!view.images.logo) return null;
  return <Png data={view.images.logo} maxWidth={LOGO_MAX_WIDTH} maxHeight={LOGO_MAX_HEIGHT} />;
}

function Party({
  label,
  party,
  tokens,
}: {
  label: string;
  party: PartyView | null;
  tokens: DesignTokens;
}) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Muted tokens={tokens}>{label}</Muted>
      {party && (
        <>
          <Text style={{ fontWeight: 700 }}>{party.name}</Text>
          {party.address.map((row, index) => (
            <Text key={index}>{row}</Text>
          ))}
          {party.identifiers.map((row) => (
            <Text key={row.label}>{`${row.label}: ${row.value}`}</Text>
          ))}
          {party.contact.map((row, index) => (
            <Text key={index}>{row}</Text>
          ))}
        </>
      )}
    </View>
  );
}

export function Parties({ view, tokens }: PartProps) {
  return (
    <View style={{ flexDirection: "row", gap: tokens.spacing.section }}>
      <Party label={view.labels.supplier} party={view.supplier} tokens={tokens} />
      <Party label={view.labels.customer} party={view.customer} tokens={tokens} />
    </View>
  );
}

export function Details({ view, tokens }: PartProps) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.spacing.section }}>
      {view.details.map((row) => (
        <View key={row.label} style={{ gap: 2 }}>
          <Muted tokens={tokens}>{row.label}</Muted>
          <Text>{row.value}</Text>
        </View>
      ))}
    </View>
  );
}

export function TextBlock({
  text,
  label,
  tokens,
}: {
  text: string;
  label?: string;
  tokens: DesignTokens;
}) {
  if (!text) return null;
  return (
    <View style={{ gap: 2 }}>
      {label && <Muted tokens={tokens}>{label}</Muted>}
      <Text>{text}</Text>
    </View>
  );
}

function LineRow({
  line,
  view,
  tokens,
  rowStyle,
}: PartProps & { line: LineView; rowStyle: ReturnType<typeof tableStyles>["row"] }) {
  const cells = tableStyles(view, tokens);
  return (
    <View style={rowStyle} wrap={!line.keepTogether}>
      <View style={cells.description}>
        <Text style={{ fontWeight: 700 }}>{line.name}</Text>
        {line.description ? (
          <Text style={{ fontSize: tokens.sizes.small, opacity: tokens.mutedOpacity }}>
            {line.description}
          </Text>
        ) : null}
      </View>
      <Text style={cells.quantity}>{line.quantity}</Text>
      <Text style={cells.unitPrice}>{line.unitPrice}</Text>
      {view.hasLineDiscount && <Text style={cells.discount}>{line.discount}</Text>}
      <Text style={cells.total}>{line.total}</Text>
    </View>
  );
}

function tableStyles(view: InvoiceView, tokens: DesignTokens) {
  const number = { textAlign: "right" as const, paddingLeft: tokens.spacing.cell };
  return {
    row: {
      flexDirection: "row" as const,
      paddingVertical: tokens.spacing.cell,
      borderBottomWidth: tokens.lineWidth,
      borderBottomColor: view.colors.line,
    },
    header: {
      flexDirection: "row" as const,
      paddingVertical: tokens.spacing.cell,
      borderBottomWidth: tokens.lineWidth * 2,
      borderBottomColor: view.colors.accent,
      fontSize: tokens.sizes.small,
      fontWeight: 700,
    },
    description: { flex: 1, gap: 2 },
    quantity: { ...number, width: COLUMNS.quantity },
    unitPrice: { ...number, width: COLUMNS.unitPrice },
    discount: { ...number, width: COLUMNS.discount },
    total: { ...number, width: COLUMNS.total },
  };
}

export function LinesTable({ view, tokens }: PartProps) {
  const cells = tableStyles(view, tokens);
  const { labels } = view;
  return (
    <View>
      <View style={cells.header} fixed>
        <Text style={cells.description}>{labels.description}</Text>
        <Text style={cells.quantity}>{labels.quantity}</Text>
        <Text style={cells.unitPrice}>{labels.unitPrice}</Text>
        {view.hasLineDiscount && <Text style={cells.discount}>{labels.discount}</Text>}
        <Text style={cells.total}>{labels.lineTotal}</Text>
      </View>
      {view.lines.map((line, index) => (
        <LineRow key={index} line={line} view={view} tokens={tokens} rowStyle={cells.row} />
      ))}
    </View>
  );
}

export function Totals({ view, tokens }: PartProps) {
  return (
    <View wrap={false} style={{ alignSelf: "flex-end", width: TOTALS_WIDTH, gap: 4 }}>
      {view.totals.map((row) => (
        <View key={row.label} style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={row.strong ? { fontWeight: 700 } : {}}>{row.label}</Text>
          <Text
            style={
              row.strong
                ? { fontWeight: 700, fontSize: tokens.sizes.heading, color: view.colors.accent }
                : {}
            }
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function PaymentRow({ row, tokens }: { row: LabeledValue; tokens: DesignTokens }) {
  return (
    <View style={{ flexDirection: "row", gap: tokens.spacing.cell }}>
      <Text style={{ width: 96, opacity: tokens.mutedOpacity }}>{row.label}</Text>
      <Text style={{ flex: 1, fontFamily: tokens.fonts.mono }}>{row.value}</Text>
    </View>
  );
}

export function PaymentBox({ view, tokens }: PartProps) {
  const { labels, payment } = view;
  return (
    <View
      wrap={false}
      style={{
        flexDirection: "row",
        gap: tokens.spacing.section,
        padding: tokens.spacing.section / 2,
        borderRadius: tokens.radius,
        backgroundColor: view.colors.surface,
      }}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ fontWeight: 700 }}>{labels.payment}</Text>
        {payment.rows.map((row) => (
          <PaymentRow key={row.label} row={row} tokens={tokens} />
        ))}
      </View>
      {payment.qr && (
        <View style={{ alignItems: "center", gap: 2 }}>
          <Image
            src={{ data: payment.qr, format: "png" }}
            cache={false}
            style={{ width: QR_SIZE, height: QR_SIZE }}
          />
          <Muted tokens={tokens}>{labels.qrCaption}</Muted>
        </View>
      )}
    </View>
  );
}

export function Signature({ view, tokens }: PartProps) {
  if (!view.images.signature) return null;
  return (
    <View wrap={false} style={{ alignSelf: "flex-end", alignItems: "flex-end", gap: 2 }}>
      <Png
        data={view.images.signature}
        maxWidth={SIGNATURE_MAX_WIDTH}
        maxHeight={SIGNATURE_MAX_HEIGHT}
      />
      <Muted tokens={tokens}>{view.labels.signature}</Muted>
    </View>
  );
}

// react-pdf drops this text when it inherits a lineHeight, so a design sets lineHeight on its content
// wrapper, never on the Page. The wrapper needs its own fontSize, which lineHeight is multiplied by.
export function PageNumber({ view, tokens }: PartProps) {
  return (
    <Text
      fixed
      style={{
        position: "absolute",
        left: tokens.spacing.page,
        right: tokens.spacing.page,
        bottom: FOOTER_BOTTOM,
        fontSize: tokens.sizes.small,
        opacity: tokens.mutedOpacity,
        textAlign: "right",
      }}
      render={({ pageNumber, totalPages }) =>
        view.labels.page(pageNumber, totalPages ?? pageNumber)
      }
    />
  );
}

export function FooterText({ view, tokens }: PartProps) {
  if (!view.footer) return null;
  return (
    <Text
      fixed
      style={{
        position: "absolute",
        left: tokens.spacing.page,
        right: tokens.spacing.page,
        bottom: FOOTER_BOTTOM + tokens.spacing.section,
        fontSize: tokens.sizes.small,
        opacity: tokens.mutedOpacity,
      }}
    >
      {view.footer}
    </Text>
  );
}

export function Watermark({ view, tokens }: PartProps) {
  if (!view.watermark) return null;
  const styles = StyleSheet.create({
    mark: {
      position: "absolute",
      top: "42%",
      left: 0,
      right: 0,
      textAlign: "center",
      fontSize: 92,
      fontWeight: 700,
      color: view.colors.text,
      opacity: tokens.watermarkOpacity,
      transform: "rotate(-30deg)",
    },
  });
  return (
    <Text fixed style={styles.mark}>
      {view.watermark}
    </Text>
  );
}
