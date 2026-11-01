import { Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { readableOn } from "@/lib/contrast";
import type { DesignTokens } from "./designs/types";
import type { InvoiceView, LabeledValue, LineView, PartyView } from "./view";

type PartProps = { view: InvoiceView; tokens: DesignTokens };

const QR_SIZE = 96;
const LOGO_MAX_WIDTH = 150;
const LOGO_MAX_HEIGHT = 56;
const LOGO_PLATE_PADDING = 5;
const LOGO_PLATE_RADIUS = 4;
const SIGNATURE_MAX_WIDTH = 140;
const SIGNATURE_MAX_HEIGHT = 56;
const A4_WIDTH = 595.28;
const FOOTER_BOTTOM = 22;
const FOOTER_LINE_HEIGHT = 1.3;
// Above the average width of Inter capitals, so the reserved space errs towards too much.
const FOOTER_CHAR_EM = 0.7;
const TOTALS_WIDTH = "50%";
const MIN_COLUMNS = { quantity: 62, unitPrice: 78, discount: 52, total: 84 };
// Wider than a digit of any bundled font: a cell narrower than its amount would break it with a hyphen.
const AMOUNT_CHAR_EM = 0.66;
const MAX_NUMBER_COLUMNS_SHARE = 0.6;
const HEADER_HEIGHT = 26;
// Calibrated on the widest default: a description column of 287 pt at 9.5 pt text.
const REFERENCE_DESCRIPTION_WIDTH = 287;
const REFERENCE_FONT_SIZE = 9.5;
const NAME_CHARS_PER_ROW = 34;
const DESCRIPTION_CHARS_PER_ROW = 44;

function contentWidth(tokens: DesignTokens): number {
  return A4_WIDTH - 2 * tokens.spacing.page - (tokens.spacing.sideInset ?? 0);
}

export function Muted({ tokens, children }: { tokens: DesignTokens; children: string }) {
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

// On a filled area a dark or transparent logo would vanish, so it gets its own light backing.
export function LogoPlate({ view, color }: { view: InvoiceView; color: string }) {
  if (!view.images.logo) return null;
  return (
    <View
      style={{
        padding: LOGO_PLATE_PADDING,
        borderRadius: LOGO_PLATE_RADIUS,
        backgroundColor: color,
      }}
    >
      <Logo view={view} />
    </View>
  );
}

export function Party({
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

type TableStyles = ReturnType<typeof tableStyles>;

function LineRow({
  line,
  view,
  tokens,
  cells,
  odd,
}: PartProps & { line: LineView; cells: TableStyles; odd: boolean }) {
  return (
    <View style={odd ? { ...cells.row, ...cells.zebra } : cells.row} wrap={!line.keepTogether}>
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

function longestWord(values: string[]): number {
  return Math.max(0, ...values.flatMap((value) => value.split(" ").map((word) => word.length)));
}

function numberColumns(view: InvoiceView, tokens: DesignTokens, fontSize: number) {
  const width = (values: string[], min: number) =>
    Math.max(min, Math.ceil(longestWord(values) * fontSize * AMOUNT_CHAR_EM) + tokens.spacing.cell);
  const { lines } = view;
  return {
    quantity: width(
      lines.map((line) => line.quantity),
      MIN_COLUMNS.quantity,
    ),
    unitPrice: width(
      lines.map((line) => line.unitPrice),
      MIN_COLUMNS.unitPrice,
    ),
    discount: view.hasLineDiscount
      ? width(
          lines.map((line) => line.discount),
          MIN_COLUMNS.discount,
        )
      : 0,
    total: width(
      lines.map((line) => line.total),
      MIN_COLUMNS.total,
    ),
  };
}

function fittedColumns(view: InvoiceView, tokens: DesignTokens) {
  const base = numberColumns(view, tokens, tokens.sizes.base);
  const used = base.quantity + base.unitPrice + base.discount + base.total;
  const available = contentWidth(tokens) * MAX_NUMBER_COLUMNS_SHARE;
  if (used <= available) return { widths: base, fontSize: tokens.sizes.base };
  return {
    widths: numberColumns(view, tokens, tokens.sizes.small),
    fontSize: tokens.sizes.small,
  };
}

function tableStyles(view: InvoiceView, tokens: DesignTokens) {
  const { widths, fontSize } = fittedColumns(view, tokens);
  const { cell } = tokens.spacing;
  const { tableHeader = "rule", tableRows = "rule", lineStyle = "solid" } = tokens.parts ?? {};
  const grid = tableRows === "grid";
  const inset = tableHeader !== "rule" || tableRows === "zebra" || grid ? cell : 0;
  const line = { width: tokens.lineWidth, color: view.colors.line };
  const cellEdge = grid
    ? { borderLeftWidth: line.width, borderLeftColor: line.color, paddingVertical: cell }
    : {};
  const number = {
    textAlign: "right" as const,
    paddingLeft: cell,
    fontSize,
    ...cellEdge,
    ...(grid && { paddingRight: cell }),
  };
  const box = grid
    ? {
        borderLeftWidth: line.width,
        borderRightWidth: line.width,
        borderLeftColor: line.color,
        borderRightColor: line.color,
      }
    : {};
  const header = {
    rule: {
      borderBottomWidth: tokens.lineWidth * 2,
      borderBottomColor: view.colors.accent,
      borderBottomStyle: lineStyle,
    },
    filled: { backgroundColor: view.colors.accent, color: readableOn(view.colors.accent) },
    surface: {
      backgroundColor: view.colors.surface,
      borderBottomWidth: tokens.lineWidth * 2,
      borderBottomColor: view.colors.accent,
    },
  }[tableHeader];
  return {
    row: {
      flexDirection: "row" as const,
      paddingVertical: grid ? 0 : cell,
      paddingLeft: grid ? 0 : inset,
      paddingRight: grid ? 0 : inset,
      ...box,
      ...(tableRows !== "plain" &&
        tableRows !== "zebra" && {
          borderBottomWidth: line.width,
          borderBottomColor: line.color,
          borderBottomStyle: lineStyle,
        }),
    },
    zebra: tableRows === "zebra" ? { backgroundColor: view.colors.surface } : {},
    header: {
      flexDirection: "row" as const,
      paddingVertical: grid ? 0 : cell,
      paddingLeft: grid ? 0 : inset,
      paddingRight: grid ? 0 : inset,
      ...box,
      ...(grid && { borderTopWidth: line.width, borderTopColor: line.color }),
      fontWeight: 700,
      ...header,
    },
    description: {
      flex: 1,
      gap: 2,
      ...(grid && { paddingVertical: cell, paddingHorizontal: cell }),
    },
    quantity: { ...number, width: widths.quantity + (grid ? cell : 0) },
    unitPrice: { ...number, width: widths.unitPrice + (grid ? cell : 0) },
    discount: { ...number, width: widths.discount + (grid ? cell : 0) },
    total: { ...number, width: widths.total + (grid ? cell : 0) },
  };
}

// react-pdf ignores minPresenceAhead on fixed nodes and leaves them behind when the rows break, so a
// spacer in front of the table moves it whole unless the header and the first row fit. The spacer
// cancels the design's gap, which InvoicePage sets to spacing.section, and react-pdf subtracts that
// negative margin from the presence, so the result adds it back.
function firstRowPresence(view: InvoiceView, tokens: DesignTokens): number {
  const first = view.lines[0];
  const { spacing, sizes } = tokens;
  const header = Math.max(HEADER_HEIGHT, 2 * sizes.small * tokens.lineHeight + 2 * spacing.cell);
  if (!first) return header + spacing.section;
  const { widths } = fittedColumns(view, tokens);
  const numbers = widths.quantity + widths.unitPrice + widths.discount + widths.total;
  const rowScale =
    ((contentWidth(tokens) - numbers) / REFERENCE_DESCRIPTION_WIDTH) *
    (REFERENCE_FONT_SIZE / sizes.base);
  const rows =
    Math.ceil(first.name.length / (NAME_CHARS_PER_ROW * rowScale)) +
    (first.keepTogether
      ? Math.ceil(first.description.length / (DESCRIPTION_CHARS_PER_ROW * rowScale))
      : 1) +
    first.description.split("\n").length -
    1;
  const rowHeight = rows * sizes.base * tokens.lineHeight + 2 * spacing.cell;
  return header + rowHeight + spacing.section;
}

export function LinesTable({ view, tokens }: PartProps) {
  const cells = tableStyles(view, tokens);
  const { labels } = view;
  const heading = (style: TableStyles["total"]) => ({ ...style, fontSize: tokens.sizes.small });
  return (
    <>
      <View
        minPresenceAhead={firstRowPresence(view, tokens)}
        style={{ marginBottom: -tokens.spacing.section }}
      />
      <View>
        <View style={cells.header} fixed>
          <Text style={{ ...cells.description, fontSize: tokens.sizes.small }}>
            {labels.description}
          </Text>
          <Text style={heading(cells.quantity)}>{labels.quantity}</Text>
          <Text style={heading(cells.unitPrice)}>{labels.unitPrice}</Text>
          {view.hasLineDiscount && <Text style={heading(cells.discount)}>{labels.discount}</Text>}
          <Text style={heading(cells.total)}>{labels.lineTotal}</Text>
        </View>
        {view.lines.map((line, index) => (
          <LineRow
            key={index}
            line={line}
            view={view}
            tokens={tokens}
            cells={cells}
            odd={index % 2 === 1}
          />
        ))}
      </View>
    </>
  );
}

export function Totals({ view, tokens }: PartProps) {
  const { totals: variant = "plain" } = tokens.parts ?? {};
  const { accent, surface } = view.colors;
  const pad = tokens.spacing.section / 2;
  const padded = { paddingHorizontal: pad, paddingVertical: pad / 2 };
  const onAccent = { backgroundColor: accent, color: readableOn(accent) };
  return (
    <View
      wrap={false}
      style={{
        alignSelf: "flex-end",
        width: TOTALS_WIDTH,
        gap: 4,
        ...(variant === "boxed" && {
          padding: pad,
          borderRadius: tokens.radius,
          backgroundColor: surface,
        }),
      }}
    >
      {view.totals.map((row) => (
        <View
          key={row.label}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            gap: tokens.spacing.cell,
            ...(variant === "band" && padded),
            ...(variant === "band" && row.strong && onAccent),
            ...(variant === "band" && row.strong && { borderRadius: tokens.radius }),
          }}
        >
          <Text style={row.strong ? { fontWeight: 700 } : {}}>{row.label}</Text>
          <Text
            style={{
              flexShrink: 0,
              ...(row.strong && {
                fontWeight: 700,
                fontSize: tokens.sizes.heading,
                ...(variant !== "band" && { color: accent }),
              }),
            }}
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

function paymentFrame(view: InvoiceView, tokens: DesignTokens) {
  const { accent, surface, line } = view.colors;
  const { lineWidth, radius, parts } = tokens;
  const { payment = "surface", lineStyle = "solid" } = parts ?? {};
  const padding = tokens.spacing.section / 2;
  return {
    surface: { padding, borderRadius: radius, backgroundColor: surface },
    outline: {
      padding,
      borderRadius: radius,
      borderWidth: lineWidth,
      borderColor: line,
      borderStyle: lineStyle,
    },
    rule: {
      paddingTop: padding,
      borderTopWidth: lineWidth * 2,
      borderTopColor: accent,
      borderTopStyle: lineStyle,
    },
    accent: { padding, borderRadius: radius, backgroundColor: accent, color: readableOn(accent) },
  }[payment];
}

export function PaymentBox({ view, tokens }: PartProps) {
  const { labels, payment } = view;
  return (
    <View
      wrap={false}
      style={{
        flexDirection: "row",
        gap: tokens.spacing.section,
        ...paymentFrame(view, tokens),
      }}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ fontWeight: 700 }}>{labels.payment}</Text>
        {payment.rows.map((row) => (
          <PaymentRow key={row.label} row={row} tokens={tokens} />
        ))}
      </View>
      {payment.qrPending && <Muted tokens={tokens}>{labels.qrAfterIssue}</Muted>}
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

function PageNumber({ view, tokens }: PartProps) {
  return (
    <Text
      fixed
      style={{
        position: "absolute",
        left: tokens.spacing.page + (tokens.spacing.sideInset ?? 0),
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

function FooterText({ view, tokens }: PartProps) {
  if (!view.footer) return null;
  return (
    <Text
      fixed
      style={{
        position: "absolute",
        left: tokens.spacing.page + (tokens.spacing.sideInset ?? 0),
        right: tokens.spacing.page,
        bottom: FOOTER_BOTTOM + tokens.spacing.section,
        fontSize: tokens.sizes.small,
        lineHeight: FOOTER_LINE_HEIGHT,
        opacity: tokens.mutedOpacity,
      }}
    >
      {view.footer}
    </Text>
  );
}

function Watermark({ view, tokens }: PartProps) {
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

function footerHeight(footer: string, tokens: DesignTokens): number {
  if (!footer) return 0;
  const { small } = tokens.sizes;
  const charsPerRow = Math.floor(contentWidth(tokens) / (small * FOOTER_CHAR_EM));
  const rows = footer
    .split("\n")
    .reduce((sum, row) => sum + Math.max(1, Math.ceil(row.length / charsPerRow)), 0);
  return rows * small * FOOTER_LINE_HEIGHT;
}

// Bleeds to the page edges from inside the content column. In the normal flow, not fixed: a fixed
// band would land on the continuation pages over the repeated table header.
export function FullBleed({
  tokens,
  backgroundColor,
  first = false,
  children,
}: {
  tokens: DesignTokens;
  backgroundColor: string;
  first?: boolean;
  children: ReactNode;
}) {
  const { page, section, sideInset = 0 } = tokens.spacing;
  return (
    <View
      style={{
        backgroundColor,
        marginLeft: -(page + sideInset),
        marginRight: -page,
        marginTop: first ? -page : -section,
        paddingLeft: page + sideInset,
        paddingRight: page,
        paddingTop: first ? page : section / 2,
        paddingBottom: first ? section : section / 2,
      }}
    >
      {children}
    </View>
  );
}

// The text layer of what every design prints under its header, in the order an invoice reads.
export function InvoiceBody({ view, tokens }: PartProps) {
  return (
    <>
      <TextBlock text={view.textBefore} tokens={tokens} />
      <LinesTable view={view} tokens={tokens} />
      <Totals view={view} tokens={tokens} />
      <TextBlock text={view.textAfter} tokens={tokens} />
      <PaymentBox view={view} tokens={tokens} />
      <TextBlock text={view.note} label={view.labels.note} tokens={tokens} />
      <TextBlock text={view.clause} tokens={tokens} />
      <TextBlock text={view.vatStatement} tokens={tokens} />
      <TextBlock text={view.registryNote} tokens={tokens} />
      <Signature view={view} tokens={tokens} />
    </>
  );
}

// Every design renders through this, so the footer reserve applies to all of them. lineHeight stays
// on the inner View with its own fontSize: PageNumber vanishes when it inherits lineHeight from Page.
// background comes first so it paints under the text; the watermark comes last so a filled block
// cannot hide it.
export function InvoicePage({
  view,
  tokens,
  background,
  children,
}: PartProps & { background?: ReactNode; children: ReactNode }) {
  const { spacing, sizes } = tokens;
  return (
    <Page
      size="A4"
      style={{
        fontFamily: tokens.fonts.body,
        fontSize: sizes.base,
        color: view.colors.text,
        paddingTop: spacing.page,
        paddingRight: spacing.page,
        paddingLeft: spacing.page + (spacing.sideInset ?? 0),
        paddingBottom:
          FOOTER_BOTTOM + 2 * spacing.section + sizes.small + footerHeight(view.footer, tokens),
      }}
    >
      {background}
      <View style={{ gap: spacing.section, fontSize: sizes.base, lineHeight: tokens.lineHeight }}>
        {children}
      </View>
      <FooterText view={view} tokens={tokens} />
      <PageNumber view={view} tokens={tokens} />
      <Watermark view={view} tokens={tokens} />
    </Page>
  );
}
