import { createServer, type Server, type Socket } from "node:net";

export type ImapMessage = { uid: number; raw: string; internalDate: Date };

export type FailKind = "auth" | "folder" | "drop";

export type TestImap = {
  port: number;
  messages: ImapMessage[];
  commands: string[];
  logins: { username: string; password: string }[];
  addMessage(raw: string, internalDate?: Date): number;
  setUidValidity(value: number): void;
  // Applies to the next connection that reaches that stage.
  failNext(kind: FailKind): void;
  // FETCH of this uid never gets an answer.
  blockUid(uid: number): void;
  hangLogout(): void;
  // LOGIN stays unanswered until release().
  holdLogin(): { release(): void };
  openSockets(): number;
  connections(): number;
  close(): Promise<void>;
};

export type ImapOptions = {
  username?: string;
  password?: string;
  folder?: string;
};

type Literal = { size: number; resolve: (text: string) => void };

function quote(value: string | null): string {
  return value === null ? "NIL" : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function headerOf(raw: string, name: string): string | null {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? "";
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(unfolded);
  return match?.[1]?.trim() ?? null;
}

function addressList(value: string | null): string {
  if (!value) return "NIL";
  const parts = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(value);
  const address = parts?.[2] ?? value;
  const name = parts?.[1]?.trim() || null;
  const [mailbox = "", host = ""] = address.split("@");
  return `((${quote(name)} NIL ${quote(mailbox)} ${quote(host)}))`;
}

function envelopeOf(raw: string): string {
  const from = addressList(headerOf(raw, "From"));
  return (
    `(${quote(headerOf(raw, "Date"))} ${quote(headerOf(raw, "Subject"))} ${from} ${from} ${from} ` +
    `${addressList(headerOf(raw, "To"))} NIL NIL NIL ${quote(headerOf(raw, "Message-ID"))})`
  );
}

function expandSet(set: string, newest: number): number[] {
  const uids: number[] = [];
  for (const part of set.split(",")) {
    const [from = "", to] = part.split(":");
    const low = from === "*" ? newest : Number(from);
    const high = to === undefined ? low : to === "*" ? newest : Number(to);
    for (let uid = Math.min(low, high); uid <= Math.max(low, high); uid += 1) uids.push(uid);
  }
  return uids;
}

// Answers only what imapflow sends for the calls in src/server/bank/imap.ts. A plain-text server:
// TLS is covered by tests/unit/host-guard.test.ts and the option checks in the client tests.
export async function startImap(options: ImapOptions = {}): Promise<TestImap> {
  const { username = "avizo", password = "tajne-heslo-imap-4c1d", folder = "INBOX" } = options;
  const messages: ImapMessage[] = [];
  const commands: string[] = [];
  const logins: TestImap["logins"] = [];
  const sockets = new Set<Socket>();
  const pending: FailKind[] = [];
  const blocked = new Set<number>();
  let silentLogout = false;
  let heldLogin: (() => void) | null = null;
  let loginGate: Promise<void> | null = null;
  let uidValidity = 1000;
  let connections = 0;

  function takeFailure(kind: FailKind): boolean {
    const index = pending.indexOf(kind);
    if (index < 0) return false;
    pending.splice(index, 1);
    return true;
  }

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    connections += 1;
    let buffer = Buffer.alloc(0);
    let literal: Literal | null = null;
    let selected = false;
    let authed = false;

    const send = (text: string) => socket.write(`${text}\r\n`);

    function search(args: string[]): string {
      const upper = args.map((arg) => arg.toUpperCase());
      const uidAt = upper.indexOf("UID");
      const newest = messages.at(-1)?.uid ?? 0;
      const wanted = uidAt >= 0 ? new Set(expandSet(args[uidAt + 1] ?? "", newest)) : null;
      const sinceAt = upper.indexOf("SINCE");
      const since = sinceAt >= 0 ? new Date(`${args[sinceAt + 1]} UTC`) : null;
      const hits = messages.filter(
        (message) =>
          (!wanted || wanted.has(message.uid)) &&
          (!since || message.internalDate.getTime() >= since.getTime()),
      );
      return hits.map((message) => message.uid).join(" ");
    }

    function fetch(tag: string, set: string, spec: string) {
      const newest = messages.at(-1)?.uid ?? 0;
      if (expandSet(set, newest).some((uid) => blocked.has(uid))) return;
      for (const uid of expandSet(set, newest)) {
        const message = messages.find((item) => item.uid === uid);
        if (!message) continue;
        const seq = messages.indexOf(message) + 1;
        const items = [`UID ${uid}`];
        if (/ENVELOPE/i.test(spec)) items.push(`ENVELOPE ${envelopeOf(message.raw)}`);
        if (/INTERNALDATE/i.test(spec))
          items.push(`INTERNALDATE "${message.internalDate.toUTCString()}"`);
        if (/RFC822\.SIZE/i.test(spec)) items.push(`RFC822.SIZE ${Buffer.byteLength(message.raw)}`);
        const body = /BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/i.exec(spec);
        if (body) {
          const bytes = Buffer.from(message.raw);
          const start = body[2] ? Number(body[2]) : 0;
          const slice = body[3] ? bytes.subarray(start, start + Number(body[3])) : bytes;
          const origin = body[2] ? `<${start}>` : "";
          items.push(`BODY[${body[1]}]${origin} {${slice.length}}\r\n${slice.toString("latin1")}`);
        }
        socket.write(`* ${seq} FETCH (${items.join(" ")})\r\n`, "latin1");
      }
      send(`${tag} OK FETCH completed`);
    }

    function handle(line: string) {
      const [tag = "", verb = "", ...rest] = line.split(" ");
      const name = verb.toUpperCase();
      const args = rest.join(" ");
      const masked = name === "LOGIN" ? `LOGIN ${rest[0]} ***` : `${name} ${args}`.trim();
      commands.push(masked);

      switch (name) {
        case "CAPABILITY":
          send("* CAPABILITY IMAP4rev1");
          return send(`${tag} OK CAPABILITY completed`);
        case "LIST": {
          const [reference = "", pattern = ""] = rest.map((part) => part.replace(/^"|"$/g, ""));
          if (reference === "" && pattern === "") send('* LIST (\\Noselect) "/" ""');
          else if (pattern.toUpperCase() === folder.toUpperCase())
            send(`* LIST () "/" "${folder}"`);
          return send(`${tag} OK LIST completed`);
        }
        case "NOOP":
          return send(`${tag} OK NOOP completed`);
        case "LOGOUT":
          if (silentLogout) return;
          send("* BYE");
          send(`${tag} OK LOGOUT completed`);
          return socket.end();
        case "LOGIN": {
          const user = (rest[0] ?? "").replace(/^"|"$/g, "");
          const pass = (rest[1] ?? "").replace(/^"|"$/g, "");
          logins.push({ username: user, password: pass });
          if (loginGate) {
            const gate = loginGate;
            loginGate = null;
            void gate.then(() => handle(line));
            return;
          }
          if (takeFailure("drop")) return socket.destroy();
          if (takeFailure("auth") || user !== username || pass !== password) {
            return send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`);
          }
          authed = true;
          return send(`${tag} OK [CAPABILITY IMAP4rev1] Logged in`);
        }
        case "SELECT":
        case "EXAMINE": {
          if (!authed) return send(`${tag} BAD Not authenticated`);
          const requested = args.replace(/^"|"$/g, "");
          if (takeFailure("folder") || requested.toUpperCase() !== folder.toUpperCase()) {
            return send(`${tag} NO [NONEXISTENT] Mailbox does not exist`);
          }
          selected = true;
          send(`* ${messages.length} EXISTS`);
          send("* 0 RECENT");
          send("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)");
          send(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid`);
          send(`* OK [UIDNEXT ${(messages.at(-1)?.uid ?? 0) + 1}] Predicted next UID`);
          const mode = name === "EXAMINE" ? "READ-ONLY" : "READ-WRITE";
          return send(`${tag} OK [${mode}] ${name} completed`);
        }
        case "UID": {
          if (!selected) return send(`${tag} BAD No mailbox selected`);
          const [sub = "", ...subArgs] = rest.slice(0);
          const kind = sub.toUpperCase();
          if (kind === "SEARCH") {
            const hits = search(subArgs);
            send(hits ? `* SEARCH ${hits}` : "* SEARCH");
            return send(`${tag} OK SEARCH completed`);
          }
          if (kind === "FETCH") {
            return fetch(tag, subArgs[0] ?? "", subArgs.slice(1).join(" "));
          }
          return send(`${tag} NO ${kind} is not available`);
        }
        default:
          return send(`${tag} NO ${name} is not available`);
      }
    }

    function drain() {
      for (;;) {
        if (literal) {
          if (buffer.length < literal.size) return;
          const text = buffer.subarray(0, literal.size).toString("latin1");
          buffer = buffer.subarray(literal.size);
          const done = literal;
          literal = null;
          done.resolve(text);
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 2);
        const announced = /\{(\d+)\+?\}$/.exec(line);
        if (announced) {
          send("+ go ahead");
          const head = line.slice(0, announced.index);
          literal = {
            size: Number(announced[1]),
            resolve: (text) => handle(`${head}"${text}"`),
          };
          continue;
        }
        handle(line);
      }
    }

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      drain();
    });
    send("* OK IMAP ready");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("IMAP server nemá port");

  return {
    port: address.port,
    messages,
    commands,
    logins,
    addMessage(raw, internalDate = new Date()) {
      const uid = (messages.at(-1)?.uid ?? 0) + 1;
      messages.push({ uid, raw, internalDate });
      return uid;
    },
    setUidValidity(value) {
      uidValidity = value;
    },
    failNext(kind) {
      pending.push(kind);
    },
    blockUid(uid) {
      blocked.add(uid);
    },
    hangLogout() {
      silentLogout = true;
    },
    holdLogin() {
      loginGate = new Promise((resolve) => {
        heldLogin = resolve;
      });
      return { release: () => heldLogin?.() };
    },
    openSockets: () => sockets.size,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
