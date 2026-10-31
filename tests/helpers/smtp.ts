import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";

export type CapturedAttachment = { filename: string | undefined; content: Buffer };

export type CapturedMail = {
  to: string[];
  raw: string;
  text: string;
  body: string;
  attachments: CapturedAttachment[];
};

export type TestSmtp = {
  port: number;
  messages: CapturedMail[];
  logins: { username: string | undefined; password: string | null | undefined }[];
  waitFor(to: string): Promise<CapturedMail>;
  // Each of these applies to the next message only.
  rejectNext(code: number): void;
  dropDuringData(): void;
  holdData(): () => void;
  stop(): Promise<void>;
};

type NextData = { reject?: number; drop?: boolean; hold?: Promise<void> };

function decodeQuotedPrintable(raw: string): string {
  return raw
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export async function startSmtp(): Promise<TestSmtp> {
  const messages: CapturedMail[] = [];
  const logins: TestSmtp["logins"] = [];
  let next: NextData = {};
  const server = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    onAuth({ username, password }, _session, callback) {
      logins.push({ username, password });
      callback(null, { user: username });
    },
    onData(stream, session, callback) {
      const { reject, drop, hold } = next;
      next = {};
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (drop) dropConnections();
      });
      stream.on("end", () => {
        if (drop) return;
        void (async () => {
          await hold;
          if (reject) {
            const error = new Error(`Odmítnuto ${reject}`) as Error & { responseCode: number };
            error.responseCode = reject;
            callback(error);
            return;
          }
          const raw = Buffer.concat(chunks);
          const parsed = await simpleParser(raw);
          messages.push({
            to: session.envelope.rcptTo.map((r) => r.address),
            raw: raw.toString("utf8"),
            text: decodeQuotedPrintable(raw.toString("utf8")),
            body: parsed.text ?? "",
            attachments: parsed.attachments.map(({ filename, content }) => ({ filename, content })),
          });
          callback();
        })();
      });
    },
  });
  function dropConnections() {
    const { connections } = server as unknown as {
      connections: Set<{ _socket: { destroy(): void } }>;
    };
    for (const connection of connections) connection._socket.destroy();
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.server.address() as { port: number };

  return {
    port,
    messages,
    logins,
    async waitFor(to) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const found = messages.findLast((m) => m.to.includes(to));
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Žádná zpráva pro ${to}`);
    },
    rejectNext(code) {
      next = { reject: code };
    },
    dropDuringData() {
      next = { drop: true };
    },
    holdData() {
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      next = { hold };
      return release;
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
