import { TOOLS } from "../tool";
import { BANK_TOOLS } from "./bank";
import { CATALOG_TOOLS } from "./catalog";
import { createDraftInvoiceTool } from "./create-draft";
import { CUSTOMER_TOOLS } from "./customers";
import { DRAFT_TOOLS } from "./drafts";
import { getInvoiceTool } from "./invoice";
import { INVOICE_READ_TOOLS } from "./invoices-read";
import { LIFECYCLE_TOOLS } from "./lifecycle";
import { getOverviewTool } from "./overview";
import { PAYMENT_TOOLS } from "./payments";
import { RECURRING_TOOLS } from "./recurring";
import { AUDIT_TOOLS } from "./audit";
import { IMPORT_TOOLS } from "./imports";
import { REPORT_TOOLS } from "./reports";
import { quickSearchTool, searchCatalogTool, searchCustomersTool } from "./search";
import { SENDING_TOOLS } from "./sending";
import { SERIES_TOOLS } from "./series";
import { SETTINGS_TOOLS } from "./settings";
import { TEMPLATE_TOOLS } from "./templates";
import { listUnpaidInvoicesTool } from "./unpaid-invoices";

// Every tool of the endpoint; server.ts imports this module, so production sees them (MCP-025).
const ALL_TOOLS = [
  getOverviewTool,
  listUnpaidInvoicesTool,
  getInvoiceTool,
  searchCustomersTool,
  searchCatalogTool,
  quickSearchTool,
  createDraftInvoiceTool,
  ...INVOICE_READ_TOOLS,
  ...DRAFT_TOOLS,
  ...CUSTOMER_TOOLS,
  ...CATALOG_TOOLS,
  ...PAYMENT_TOOLS,
  ...BANK_TOOLS,
  ...LIFECYCLE_TOOLS,
  ...SENDING_TOOLS,
  ...RECURRING_TOOLS,
  ...TEMPLATE_TOOLS,
  ...SERIES_TOOLS,
  ...SETTINGS_TOOLS,
  ...REPORT_TOOLS,
  ...AUDIT_TOOLS,
  ...IMPORT_TOOLS,
];

for (const tool of ALL_TOOLS) {
  if (!TOOLS.includes(tool)) TOOLS.push(tool);
}
