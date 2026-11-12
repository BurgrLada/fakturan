import { TOOLS } from "../tool";
import { BANK_TOOLS } from "./bank";
import { CATALOG_TOOLS } from "./catalog";
import { createDraftInvoiceTool } from "./create-draft";
import { CUSTOMER_TOOLS } from "./customers";
import { DRAFT_TOOLS } from "./drafts";
import { getInvoiceTool } from "./invoice";
import { INVOICE_READ_TOOLS } from "./invoices-read";
import { getOverviewTool } from "./overview";
import { PAYMENT_TOOLS } from "./payments";
import { searchCatalogTool, searchCustomersTool } from "./search";
import { listUnpaidInvoicesTool } from "./unpaid-invoices";

// Every tool of the endpoint; server.ts imports this module, so production sees them (MCP-025).
const ALL_TOOLS = [
  getOverviewTool,
  listUnpaidInvoicesTool,
  getInvoiceTool,
  searchCustomersTool,
  searchCatalogTool,
  createDraftInvoiceTool,
  ...INVOICE_READ_TOOLS,
  ...DRAFT_TOOLS,
  ...CUSTOMER_TOOLS,
  ...CATALOG_TOOLS,
  ...PAYMENT_TOOLS,
  ...BANK_TOOLS,
];

for (const tool of ALL_TOOLS) {
  if (!TOOLS.includes(tool)) TOOLS.push(tool);
}
