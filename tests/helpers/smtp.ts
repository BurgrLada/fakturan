import { SMTPServer } from "smtp-server";

export type CapturedMail = { to: string[]; raw: string; text: string };

export type TestSmtp = {
  port: number;
  messages: CapturedMail[];
  waitFor(to: string): Promise<CapturedMail>;
  stop(): Promise<void>;
};

function decodeQuotedPrintable(raw: string): string {
  return raw
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export async function startSmtp(): Promise<TestSmtp> {
  const messages: CapturedMail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        messages.push({
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
          text: decodeQuotedPrintable(raw),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.server.address() as { port: number };

  return {
    port,
    messages,
    async waitFor(to) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const found = messages.findLast((m) => m.to.includes(to));
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Žádná zpráva pro ${to}`);
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
