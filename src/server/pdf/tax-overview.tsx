import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatMoney } from "@/lib/money";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { TaxOverview } from "../reports/tax";
import { DESIGNS } from "./designs";
import { registerFonts, reloadFonts } from "./fonts";
import { serializeRender } from "./render";
import { lineNote, unconvertedText } from "@/lib/tax-text";

const T = TEXTS.tax;
// The first design is the default one: the overview borrows its tokens instead of own colours.
const tokens = DESIGNS[0]!.tokens;

const styles = StyleSheet.create({
  page: {
    paddingTop: 118,
    paddingBottom: 48,
    paddingHorizontal: tokens.spacing.page,
    fontFamily: tokens.fonts.body,
    fontSize: tokens.sizes.small,
    color: tokens.colors.text,
  },
  header: { position: "absolute", top: 28, left: tokens.spacing.page, right: tokens.spacing.page },
  title: { fontFamily: tokens.fonts.heading, fontSize: tokens.sizes.heading, fontWeight: 700 },
  disclaimer: {
    marginTop: 6,
    padding: 6,
    borderWidth: tokens.lineWidth,
    borderColor: tokens.colors.line,
    backgroundColor: tokens.colors.surface,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: tokens.lineWidth,
    borderBottomColor: tokens.colors.line,
    paddingVertical: 3,
  },
  head: { fontWeight: 700 },
  cell: { paddingRight: 4 },
  amount: { textAlign: "right", paddingRight: 4 },
  total: { flexDirection: "row", marginTop: 6, fontWeight: 700 },
  note: { marginTop: 6 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: tokens.spacing.page,
    right: tokens.spacing.page,
    textAlign: "right",
    opacity: tokens.mutedOpacity,
  },
});

const day = (date: string | null) => (date ? formatCalendarDate(date, "d. M. yyyy") : "–");
const czk = (minor: number | null) => (minor === null ? "–" : formatMoney(minor, "CZK"));

type Column = { label: string; width: string; align?: "right" };

const LINE_COLUMNS: Column[] = [
  { label: T.columns.date, width: "12%" },
  { label: T.columns.number, width: "13%" },
  { label: T.columns.customer, width: "22%" },
  { label: T.columns.amount, width: "15%", align: "right" },
  { label: T.columns.czk, width: "15%", align: "right" },
  { label: T.columns.note, width: "23%" },
];

const UNPAID_COLUMNS: Column[] = [
  { label: T.columns.issueDate, width: "13%" },
  { label: T.columns.dueDate, width: "13%" },
  { label: T.columns.number, width: "14%" },
  { label: T.columns.customer, width: "28%" },
  { label: T.columns.due, width: "16%", align: "right" },
  { label: T.columns.czk, width: "16%", align: "right" },
];

function Cells({ columns, values }: { columns: Column[]; values: string[] }) {
  return (
    <>
      {columns.map((column, index) => (
        <Text
          key={column.label}
          style={[column.align ? styles.amount : styles.cell, { width: column.width }]}
        >
          {values[index]}
        </Text>
      ))}
    </>
  );
}

// Fixed, so the title and the notice of TAX-004 open every page, the column header included.
function Header({ overview, columns }: { overview: TaxOverview; columns: Column[] }) {
  return (
    <View fixed style={styles.header}>
      <Text style={styles.title}>
        {T.title} {overview.year}
      </Text>
      <Text>{T.bases[overview.basis]}</Text>
      <Text style={styles.disclaimer}>{T.disclaimer}</Text>
      <View style={[styles.row, styles.head, { marginTop: 8 }]}>
        <Cells columns={columns} values={columns.map((column) => column.label)} />
      </View>
    </View>
  );
}

function Footer() {
  return (
    <Text
      fixed
      style={styles.footer}
      render={({ pageNumber, totalPages }) => T.page(pageNumber, totalPages)}
    />
  );
}

function TaxDocument({ overview }: { overview: TaxOverview }) {
  const totalLabel =
    overview.basis === "paid" ? T.incomeTotal(overview.year) : T.issuedTotal(overview.year);
  const missing = unconvertedText(overview.unconverted);
  return (
    <Document title={`${T.title} ${overview.year}`} language="cs">
      <Page size="A4" style={styles.page}>
        <Header overview={overview} columns={LINE_COLUMNS} />
        {overview.lines.length === 0 && <Text>{T.empty}</Text>}
        {overview.lines.map((line, index) => (
          <View key={`${line.invoiceId}-${index}`} style={styles.row} wrap={false}>
            <Cells
              columns={LINE_COLUMNS}
              values={[
                day(line.date),
                line.number,
                line.customer,
                formatMoney(line.amountMinor, line.currency),
                czk(line.czkMinor),
                lineNote(line),
              ]}
            />
          </View>
        ))}
        <View style={styles.total} wrap={false}>
          <Text style={{ width: "62%" }}>{totalLabel}</Text>
          <Text style={[styles.amount, { width: "15%" }]}>{czk(overview.totalCzkMinor)}</Text>
        </View>
        {overview.estimated.count > 0 && (
          <Text style={styles.note}>
            {T.estimated(overview.estimated.count, czk(overview.estimated.czkMinor))}
          </Text>
        )}
        {missing && <Text style={styles.note}>{missing}</Text>}
        <Footer />
      </Page>
      <Page size="A4" style={styles.page}>
        <Header overview={overview} columns={UNPAID_COLUMNS} />
        <Text style={[styles.head, { marginBottom: 4 }]}>
          {T.unpaidTitle(day(overview.asOf), overview.asOfToday)}
        </Text>
        {overview.unpaid.length === 0 && <Text>{T.unpaidEmpty}</Text>}
        {overview.unpaid.map((row) => (
          <View key={row.invoiceId} style={styles.row} wrap={false}>
            <Cells
              columns={UNPAID_COLUMNS}
              values={[
                day(row.issueDate),
                day(row.dueDate),
                row.number,
                row.customer,
                formatMoney(row.dueMinor, row.currency),
                czk(row.czkMinor),
              ]}
            />
          </View>
        ))}
        <View style={styles.total} wrap={false}>
          <Text style={{ width: "68%" }}>{T.unpaidTotal}</Text>
          <Text style={[styles.amount, { width: "32%" }]}>{czk(overview.unpaidCzkMinor)}</Text>
        </View>
        <Text style={styles.note}>{T.cancelledNote}</Text>
        <Footer />
      </Page>
    </Document>
  );
}

// The invoice renderer stays as it is; this shares only its queue and its fonts.
export function renderTaxOverviewPdf(overview: TaxOverview): Promise<Buffer> {
  return serializeRender(() => {
    registerFonts();
    reloadFonts();
    return renderToBuffer(<TaxDocument overview={overview} />);
  });
}
