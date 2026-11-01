import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const fixture = (name: string) => readFileSync(join(__dirname, "../fixtures/cnb", name), "utf8");

export type CnbMode =
  | { kind: "ok" }
  | { kind: "down" }
  | { kind: "garbage" }
  | { kind: "big" }
  | { kind: "date"; date: string };

export const cnbMode = {
  ok: { kind: "ok" } as CnbMode,
  down: { kind: "down" } as CnbMode,
  garbage: { kind: "garbage" } as CnbMode,
  big: { kind: "big" } as CnbMode,
  date: (date: string): CnbMode => ({ kind: "date", date }),
};

function titled(text: string, isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return text.replace(/^\d{2}\.\d{2}\.\d{4}/, `${day}.${month}.${year}`);
}

function body(mode: CnbMode): { status: number; text: string } {
  switch (mode.kind) {
    case "ok":
      return { status: 200, text: fixture("denni-kurz.txt") };
    case "down":
      return { status: 500, text: "chyba" };
    case "garbage":
      return { status: 200, text: "<html><body>Údržba</body></html>" };
    case "big":
      return { status: 200, text: `${fixture("denni-kurz.txt")}${"x".repeat(70 * 1024)}` };
    case "date":
      return { status: 200, text: titled(fixture("denni-kurz.txt"), mode.date) };
  }
}

// A local stand-in for the CNB daily list, so no test reaches the public network.
export async function startCnbStub(initial: CnbMode = cnbMode.ok) {
  let mode = initial;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const { status, text } = body(mode);
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setMode(next: CnbMode) {
      mode = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
