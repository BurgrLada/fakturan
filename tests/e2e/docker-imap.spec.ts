import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startImap, type ImapOptions, type TestImap } from "../helpers/imap";
import { checkNow, expectPaid, notice, payableInvoice, saveMailbox } from "./bank-flow";
import { DOCKER_HOST_NAME, expect, test as base } from "./fixtures";
import { register } from "./invoice-helpers";

type Certificates = {
  ca: string;
  trusted: ImapOptions["tls"];
  wrongName: ImapOptions["tls"];
  unknownIssuer: ImapOptions["tls"];
};

const certDir = mkdtempSync(join(tmpdir(), "fakturan-imap-tls-"));

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: certDir, stdio: "ignore" });
}

function selfSigned(name: string, subject: string) {
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.pem`,
    "-subj",
    `/CN=${subject}`,
  );
}

function issued(name: string, host: string) {
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${host}`,
  );
  writeFileSync(join(certDir, `${name}.ext`), `subjectAltName=DNS:${host}\n`);
  openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.pem`,
  );
}

const pair = (name: string) => ({
  key: readFileSync(join(certDir, `${name}.key`), "utf8"),
  cert: readFileSync(join(certDir, `${name}.pem`), "utf8"),
});

function certificates(): Certificates {
  selfSigned("ca", "Fakturan test CA");
  selfSigned("stranger", DOCKER_HOST_NAME);
  issued("server", DOCKER_HOST_NAME);
  issued("other", "imap.example.test");
  // The container runs as another user and reads the mounted file.
  chmodSync(join(certDir, "ca.pem"), 0o644);
  return {
    ca: join(certDir, "ca.pem"),
    trusted: pair("server"),
    wrongName: pair("other"),
    unknownIssuer: pair("stranger"),
  };
}

const certs = process.env.E2E_DOCKER_IMAGE ? certificates() : null;

const test = base.extend<{ imapWith: (tls: ImapOptions["tls"]) => Promise<TestImap> }>({
  // oxlint-disable-next-line no-empty-pattern
  imapWith: async ({}, use) => {
    const started: TestImap[] = [];
    await use(async (tls) => {
      // Every interface, because the container comes in through the Docker bridge.
      const server = await startImap({ host: "0.0.0.0", tls });
      started.push(server);
      return server;
    });
    await Promise.all(started.map((server) => server.close()));
  },
});

test.skip(!process.env.E2E_DOCKER_IMAGE, "Běží jen proti obrazu z E2E_DOCKER_IMAGE");
test.setTimeout(150_000);
test.use({ allowPrivateMail: true, dockerCaFile: certs?.ca ?? null });
test.afterAll(() => rmSync(certDir, { recursive: true, force: true }));

const SHARP_SMOKE = `require("sharp")({
  create: { width: 2, height: 2, channels: 3, background: "red" },
}).png().toBuffer().then((data) => process.exit(data.length > 0 ? 0 : 1));`;

test("[OPS-004] obraz: čtení schránky běží a health je ok", async ({
  page,
  dockerApp,
  imapWith,
}) => {
  const { baseURL, container } = dockerApp;
  const read = async () => {
    const res = await fetch(`${baseURL}/api/health`);
    return { code: res.status, body: await res.json() };
  };
  await expect
    .poll(read, { timeout: 15_000 })
    .toEqual({ code: 200, body: { status: "ok", database: "ok", scheduler: "running" } });
  execFileSync("docker", ["exec", container, "node", "-e", SHARP_SMOKE], { stdio: "pipe" });

  const imap = await imapWith(certs!.trusted);
  const invoiceUrl = await payableInvoice(page, baseURL);
  await saveMailbox(page, baseURL, { host: DOCKER_HOST_NAME, port: imap.port, tls: "implicit" });

  // A real run through imapflow and mailparser, both resolved from the traced image.
  imap.addMessage(notice());
  await checkNow(page, baseURL);

  await expectPaid(page, invoiceUrl);
  await expect(page.getByTestId("payment-row")).toContainText("Z avíza");
  expect(imap.logins).toEqual(
    expect.arrayContaining([expect.objectContaining({ username: "avizo" })]),
  );
  expect(imap.commands.some((command) => command.startsWith("EXAMINE"))).toBe(true);
});

for (const [name, certificate] of [
  ["na jiné jméno", () => certs!.wrongName],
  ["od neznámé autority", () => certs!.unknownIssuer],
] as const) {
  test(`[OPS-004] obraz: certifikát ${name} schránka odmítne a heslo neodejde`, async ({
    page,
    dockerApp,
    imapWith,
  }) => {
    const { baseURL } = dockerApp;
    const imap = await imapWith(certificate());
    await register(page, baseURL);
    await saveMailbox(page, baseURL, { host: DOCKER_HOST_NAME, port: imap.port, tls: "implicit" });

    await page.getByRole("button", { name: "Vyzkoušet připojení" }).click();

    await expect(page.getByRole("status")).toContainText("Připojení se nepodařilo");
    await expect.poll(() => imap.refusedHandshakes()).toBeGreaterThan(0);
    expect(imap.logins).toEqual([]);
  });
}
