import { TOOLS } from "../tool";
import { createDraftInvoiceTool } from "./create-draft";
import { getInvoiceTool } from "./invoice";
import { getOverviewTool } from "./overview";
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
];

for (const tool of ALL_TOOLS) {
  if (!TOOLS.includes(tool)) TOOLS.push(tool);
}
