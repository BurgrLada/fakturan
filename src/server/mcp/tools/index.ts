import { TOOLS } from "../tool";
import { getInvoiceTool } from "./invoice";
import { getOverviewTool } from "./overview";
import { searchCatalogTool, searchCustomersTool } from "./search";
import { listUnpaidInvoicesTool } from "./unpaid-invoices";

// Every tool of the endpoint; server.ts imports this module, so production sees them (MCP-025).
const READ_TOOLS = [
  getOverviewTool,
  listUnpaidInvoicesTool,
  getInvoiceTool,
  searchCustomersTool,
  searchCatalogTool,
];

for (const tool of READ_TOOLS) {
  if (!TOOLS.includes(tool)) TOOLS.push(tool);
}
