import { Table, TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { formatBytes, formatDateTime } from "@/lib/format";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { getInstanceStatus } from "@/server/services/instance-status";

const T = TEXTS.instanceStatus;

type Status = ReturnType<typeof getInstanceStatus>;

function backupText(status: Status): string {
  return [
    status.lastBackupAt ? formatDateTime(status.lastBackupAt) : T.none,
    status.lastBackupFailedAt
      ? `${T.backupFailed} (${formatDateTime(status.lastBackupFailedAt)})`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function heavyText(status: Status): string {
  const running = status.heavyRunningSince
    ? `, ${T.heavyRunning(formatDateTime(status.heavyRunningSince))}`
    : "";
  return `${status.heavyQueued}${running}`;
}

export function InstanceStatus({ status }: { status: Status }) {
  const rows: [string, string][] = [
    [T.labels.version, status.version],
    [T.labels.database, formatBytes(status.databaseBytes)],
    [T.labels.files, status.filesBytes === null ? T.notMeasured : formatBytes(status.filesBytes)],
    [T.labels.free, status.freeBytes === null ? T.unknown : formatBytes(status.freeBytes)],
    [T.labels.scheduler, T.scheduler[status.scheduler]],
    [T.labels.backup, backupText(status)],
    [
      T.labels.fx,
      status.fxLastDate ? formatCalendarDate(status.fxLastDate, "d. M. yyyy") : T.noList,
    ],
    [T.labels.heavy, heavyText(status)],
    [T.labels.smtp, status.smtpConfigured ? T.configured : T.notConfigured],
    [T.labels.monitoring, status.monitoringConfigured ? T.configured : T.notConfigured],
  ];
  return (
    <Table>
      <TableBody>
        {rows.map(([label, value]) => (
          <TableRow key={label}>
            <TableHead scope="row">{label}</TableHead>
            <TableCell>{value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
