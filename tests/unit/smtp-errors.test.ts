import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { classifySmtpError, smtpFailureText } from "@/lib/smtp-errors";
import { BlockedHostError } from "@/server/mail/host-guard";
import { deliver } from "@/server/mail/transport";

const spy = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock("nodemailer", async (original) => {
  const real = await original<typeof import("nodemailer")>();
  return {
    ...real,
    createTransport: (options: Record<string, unknown>) => {
      spy.options.push(options);
      return real.createTransport(options);
    },
  };
});

// A server scripted line by line: nodemailer's errors must be observed, not remembered.
type Reply = string | "drop" | "silent";
type Script = Partial<Record<"greet" | "EHLO" | "MAIL" | "RCPT" | "DATA" | "body" | "end", Reply>>;

const DEFAULTS: Required<Script> = {
  greet: "220 test",
  EHLO: "250 test",
  MAIL: "250 ok",
  RCPT: "250 ok",
  DATA: "354 go",
  body: "silent",
  end: "250 queued",
};

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function act(socket: Socket, reply: Reply) {
  if (reply === "drop") socket.destroy();
  else if (reply !== "silent") socket.write(`${reply}\r\n`);
}

async function scripted(script: Script): Promise<number> {
  const rules = { ...DEFAULTS, ...script };
  server = createServer((socket) => {
    socket.on("error", () => {});
    let inData = false;
    let buffer = "";
    act(socket, rules.greet);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (inData) {
        act(socket, rules.body);
        if (buffer.includes("\r\n.\r\n")) {
          inData = false;
          buffer = "";
          act(socket, rules.end);
        }
        return;
      }
      for (let at = buffer.indexOf("\r\n"); at !== -1; at = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const verb = line.slice(0, 4).toUpperCase() as "EHLO" | "MAIL" | "RCPT" | "DATA";
        if (verb === "DATA") inData = true;
        act(socket, rules[verb] ?? "500 what");
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as { port: number }).port;
}

const MESSAGE = {
  from: "a@example.cz",
  to: ["b@example.cz"],
  subject: "S",
  text: "T",
};

const FAST = { connectionTimeout: 300, greetingTimeout: 300, socketTimeout: 300 };

async function failure(script: Script, port?: number) {
  const target = { host: "127.0.0.1", port: port ?? (await scripted(script)) };
  try {
    await deliver(target, undefined, MESSAGE, FAST);
  } catch (error) {
    return error;
  }
  throw new Error("Odeslání nemělo projít");
}

describe("skutečné chyby nodemaileru", () => {
  test.each<[string, Script, "retry" | "permanent" | "ambiguous"]>([
    ["spojení ukončené místo uvítání", { greet: "drop" }, "retry"],
    ["server bez uvítání", { greet: "silent" }, "retry"],
    ["ukončení po EHLO", { EHLO: "drop" }, "retry"],
    ["ukončení po MAIL", { MAIL: "drop" }, "retry"],
    ["ukončení po RCPT", { RCPT: "drop" }, "retry"],
    ["ticho po MAIL", { MAIL: "silent" }, "retry"],
    ["421 uvítání", { greet: "421 busy" }, "retry"],
    ["451 na MAIL", { MAIL: "451 later" }, "retry"],
    ["421 na MAIL", { MAIL: "421 later" }, "retry"],
    ["450 na všechny příjemce", { RCPT: "450 later" }, "retry"],
    ["550 na všechny příjemce", { RCPT: "550 nobody" }, "permanent"],
    ["553 na MAIL", { MAIL: "553 sender" }, "permanent"],
    ["554 na DATA", { DATA: "554 no" }, "permanent"],
    ["451 na DATA", { DATA: "451 later" }, "retry"],
    ["451 po těle zprávy", { end: "451 later" }, "retry"],
    ["421 po těle zprávy", { end: "421 later" }, "retry"],
    ["550 po těle zprávy", { end: "550 spam" }, "permanent"],
    ["ukončení během těla", { body: "drop" }, "ambiguous"],
    ["ukončení po těle bez odpovědi", { end: "drop" }, "ambiguous"],
    ["ticho po těle", { end: "silent" }, "ambiguous"],
    ["ukončení hned po DATA", { DATA: "drop" }, "ambiguous"],
  ])("%s", async (_name, script, expected) => {
    expect(classifySmtpError(await failure(script))).toBe(expected);
  });

  test("odmítnuté spojení se opakuje", async () => {
    const port = await scripted({});
    await new Promise((resolve) => server!.close(resolve));
    expect(classifySmtpError(await failure({}, port))).toBe("retry");
  });

  test("špatné přihlášení je trvalé", async () => {
    const script: Script = { EHLO: "250-test\r\n250 AUTH PLAIN" };
    const port = await scripted(script);
    server!.removeAllListeners("connection");
    server!.on("connection", (socket) => {
      socket.write("220 test\r\n");
      socket.on("data", (chunk) => {
        const verb = chunk.toString().slice(0, 4);
        socket.write(verb === "EHLO" ? "250-test\r\n250 AUTH PLAIN\r\n" : "535 bad login\r\n");
      });
    });
    const target = { host: "127.0.0.1", port, auth: { user: "u", pass: "p" } };
    const error = await deliver(target, undefined, MESSAGE, FAST).catch((e: unknown) => e);
    expect(classifySmtpError(error)).toBe("permanent");
  });

  test("text odpovědi je oříznutý a bez konců řádků", async () => {
    const text = smtpFailureText(await failure({ RCPT: `550 ${"x".repeat(300)}` }));
    expect(text).toHaveLength(200);
    expect(text).toMatch(/^550 x+$/);
    expect(smtpFailureText(await failure({ end: "drop" }))).toBeNull();
    expect(smtpFailureText({ response: "550 a\r\nb" })).toBe("550 a b");
  });
});

test("fronta má limity spojení i bez ověřeného hostitele, tedy i na instančním SMTP", async () => {
  const port = await scripted({});
  await deliver({ host: "127.0.0.1", port }, undefined, MESSAGE).catch(() => {});
  expect(spy.options.at(-1)).toMatchObject({
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
});

describe("chyby mimo nodemailer", () => {
  test("dočasný výpadek DNS se opakuje, zakázaný hostitel je trvalý", () => {
    expect(classifySmtpError(new BlockedHostError(true))).toBe("retry");
    expect(classifySmtpError(new BlockedHostError())).toBe("permanent");
  });

  test.each([[new TypeError("x")], ["text"], [null], [{ code: "ECONNECTION" }]])(
    "neznámá chyba je nejasná: nikdy se neopakuje (%#)",
    (error) => {
      expect(classifySmtpError(error)).toBe("ambiguous");
    },
  );
});
