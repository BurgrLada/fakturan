import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { McpLevel } from "@/lib/mcp-settings";
import { TEXTS } from "@/lib/texts";
import { ClearCallLogButton } from "./clear-call-log-button";

const T = TEXTS.mcp.callLog;

export type CallLogOutcome = "ok" | "denied" | "error";

export type CallLogRow = {
  id: number;
  at: string;
  clientName: string;
  tool: string;
  outcome: CallLogOutcome;
  reason: keyof typeof T.reasons | null;
  requiredLevel: McpLevel | null;
};

export type CallLogFilter = { clientId?: string; outcome?: CallLogOutcome; page: number };

// Query keys of the log's filter and paging on /nastaveni/asistenti.
export const CALL_LOG_PARAMS = { client: "asistent", outcome: "vysledek", page: "strana" } as const;

function pageHref(filter: CallLogFilter, page: number): string {
  const params = new URLSearchParams();
  if (filter.clientId) params.set(CALL_LOG_PARAMS.client, filter.clientId);
  if (filter.outcome) params.set(CALL_LOG_PARAMS.outcome, filter.outcome);
  if (page > 1) params.set(CALL_LOG_PARAMS.page, String(page));
  const query = params.toString();
  return `/nastaveni/asistenti${query ? `?${query}` : ""}#mcp-call-log`;
}

// The call log (MCP-063): newest first, 50 per page, filtered by assistant and outcome.
export function AssistantCallLog({
  rows,
  filter,
  hasNext,
  clients,
  logging,
}: {
  rows: CallLogRow[];
  filter: CallLogFilter;
  hasNext: boolean;
  clients: { clientId: string; clientName: string }[];
  logging: boolean;
}) {
  const filtered = Boolean(filter.clientId || filter.outcome) || filter.page > 1;
  return (
    <section aria-labelledby="mcp-call-log" className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="mcp-call-log" className="text-lg">
          {T.title}
        </h2>
        {(rows.length > 0 || filtered) && <ClearCallLogButton />}
      </div>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      {!logging && <p className="text-sm">{T.off}</p>}
      <form
        action="/nastaveni/asistenti#mcp-call-log"
        method="get"
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1 text-sm">
          {T.filterClient}
          <NativeSelect name={CALL_LOG_PARAMS.client} defaultValue={filter.clientId ?? ""}>
            <option value="">{T.all}</option>
            {clients.map((client) => (
              <option key={client.clientId} value={client.clientId}>
                {client.clientName}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {T.filterOutcome}
          <NativeSelect name={CALL_LOG_PARAMS.outcome} defaultValue={filter.outcome ?? ""}>
            <option value="">{T.all}</option>
            {(Object.keys(T.outcomes) as CallLogOutcome[]).map((outcome) => (
              <option key={outcome} value={outcome}>
                {T.outcomes[outcome]}
              </option>
            ))}
          </NativeSelect>
        </label>
        <Button type="submit" size="sm" variant="outline">
          {T.filter}
        </Button>
      </form>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{T.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={T.tableLabel}>
            <TableHeader>
              <TableRow>
                <TableHead>{T.columns.at}</TableHead>
                <TableHead>{T.columns.client}</TableHead>
                <TableHead>{T.columns.tool}</TableHead>
                <TableHead>{T.columns.outcome}</TableHead>
                <TableHead>{T.columns.reason}</TableHead>
                <TableHead>{T.columns.requiredLevel}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">{row.at}</TableCell>
                  {/* The client's own name, rendered as text only. */}
                  <TableCell className="break-words">{row.clientName}</TableCell>
                  <TableCell>
                    <code className="text-xs">{row.tool}</code>
                  </TableCell>
                  <TableCell>{T.outcomes[row.outcome]}</TableCell>
                  <TableCell>{row.reason ? T.reasons[row.reason] : ""}</TableCell>
                  <TableCell>
                    {row.requiredLevel ? TEXTS.mcp.levels[row.requiredLevel].name : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {(filter.page > 1 || hasNext) && (
        <nav className="flex gap-2 text-sm">
          {filter.page > 1 && (
            <Link className="underline" href={pageHref(filter, filter.page - 1)}>
              {T.previous}
            </Link>
          )}
          {hasNext && (
            <Link className="underline" href={pageHref(filter, filter.page + 1)}>
              {T.next}
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}
