import { renderInvoicePdf } from "../src/server/pdf/render";
import { buildInvoiceView } from "../src/server/pdf/view";
import { FIXTURE_LOGO_SVG, INVOICE_FIXTURES } from "../tests/fixtures/invoices";

export async function renderFixture(): Promise<{ pdf: Buffer; hasLogo: boolean }> {
  const view = await buildInvoiceView(INVOICE_FIXTURES.short, {
    today: "2026-03-10",
    draft: false,
    readImage: () => FIXTURE_LOGO_SVG,
  });
  return { pdf: await renderInvoicePdf(view), hasLogo: view.images.logo !== null };
}
