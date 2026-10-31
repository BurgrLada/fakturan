import { beforeEach, describe, expect, test, vi } from "vitest";
import { assertPublicHost, BlockedHostError, isPrivateAddress } from "@/server/mail/host-guard";
import { smtpOptions } from "@/server/mail/transport";

const dns = vi.hoisted(() => ({ records: [] as string[] }));

vi.mock("node:dns/promises", () => ({
  lookup: async (_host: string, opts: { all: boolean }) => {
    if (!opts.all) throw new Error("kontrola musí vidět všechny záznamy");
    if (dns.records.length === 0) throw new Error("ENOTFOUND");
    return dns.records.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

const PRIVATE_ADDRESSES = [
  "0.0.0.1",
  "10.0.0.1",
  "100.64.0.1",
  "100.127.255.254",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.19.255.255",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "::1",
  "::",
  "fc00::1",
  "fd12:3456::1",
  "fe80::1",
  "fe80::1%eth0",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:10.0.0.1",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "nesmysl",
  "",
];

const PUBLIC_ADDRESSES = [
  "8.8.8.8",
  "100.63.255.255",
  "100.128.0.1",
  "172.15.255.255",
  "172.32.0.1",
  "192.0.1.1",
  "198.17.255.255",
  "198.20.0.1",
  "223.255.255.255",
  "2a00:1450:4001::1",
  "::ffff:8.8.8.8",
];

const open = { allowPrivate: false };
const allowed = { allowPrivate: true };

beforeEach(() => {
  dns.records = ["8.8.8.8"];
});

describe("isPrivateAddress", () => {
  test.each(PRIVATE_ADDRESSES)("[SEC-007] %s je privátní", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  test.each(PUBLIC_ADDRESSES)("%s je veřejná", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("assertPublicHost", () => {
  test("[SEC-007] hostitel s jedním privátním záznamem je odmítnutý", async () => {
    dns.records = ["8.8.8.8", "10.0.0.5"];
    await expect(assertPublicHost("smtp.example.cz", 587, open)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
  });

  test("[SEC-007] ::ffff:127.0.0.1 je odmítnutý", async () => {
    dns.records = ["::ffff:127.0.0.1"];
    await expect(assertPublicHost("smtp.example.cz", 587, open)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
  });

  test("hostitel bez záznamu je odmítnutý stejně jako privátní", async () => {
    dns.records = [];
    await expect(assertPublicHost("neni.example.cz", 587, open)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
  });

  test("[SEC-007] port 22 je odmítnutý, 587 projde", async () => {
    await expect(assertPublicHost("smtp.example.cz", 22, open)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
    await expect(assertPublicHost("smtp.example.cz", 587, open)).resolves.toEqual({
      address: "8.8.8.8",
      isPrivate: false,
    });
  });

  test.each([25, 465, 587, 2525])("port %i je povolený", async (port) => {
    await expect(assertPublicHost("smtp.example.cz", port, open)).resolves.toMatchObject({
      isPrivate: false,
    });
  });

  test("[SEC-007] ALLOW_PRIVATE_MAIL_HOSTS povolí privátní cíl a jen pro něj nevyžaduje TLS", async () => {
    dns.records = ["10.0.0.5"];
    const inner = await assertPublicHost("mail.lan", 1025, allowed);
    expect(inner).toEqual({ address: "10.0.0.5", isPrivate: true });
    expect(
      smtpOptions({ host: inner.address, port: 1025 }, { servername: "mail.lan", isPrivate: true }),
    ).toMatchObject({ requireTLS: false });

    dns.records = ["8.8.8.8"];
    const outer = await assertPublicHost("smtp.example.cz", 587, allowed);
    expect(outer.isPrivate).toBe(false);
    expect(
      smtpOptions(
        { host: outer.address, port: 587 },
        { servername: "smtp.example.cz", isPrivate: false },
      ),
    ).toMatchObject({ requireTLS: true });
  });

  test("výjimka pro privátní cíl neruší omezení portu u veřejného", async () => {
    await expect(assertPublicHost("smtp.example.cz", 22, allowed)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
  });

  test("smíšené záznamy s výjimkou se posuzují podle cíle, na který se jde", async () => {
    dns.records = ["8.8.8.8", "10.0.0.5"];
    await expect(assertPublicHost("smtp.example.cz", 587, allowed)).resolves.toEqual({
      address: "8.8.8.8",
      isPrivate: false,
    });
  });
});

describe("smtpOptions", () => {
  const verified = { servername: "smtp.example.cz", isPrivate: false };

  test("spojení jde na ověřenou IP se servername původního hostitele", () => {
    expect(smtpOptions({ host: "8.8.8.8", port: 587 }, verified)).toMatchObject({
      host: "8.8.8.8",
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { servername: "smtp.example.cz" },
    });
  });

  test("465 je přímé TLS", () => {
    expect(smtpOptions({ host: "8.8.8.8", port: 465 }, verified)).toMatchObject({
      secure: true,
      requireTLS: false,
    });
  });

  test("IP místo hostitele nejde do SNI", () => {
    const options = smtpOptions(
      { host: "8.8.8.8", port: 587 },
      { servername: "8.8.8.8", isPrivate: false },
    );
    expect(options).not.toHaveProperty("tls");
    expect(options).toMatchObject({ requireTLS: true });
  });

  test("limity platí a protokolování je vypnuté", () => {
    expect(smtpOptions({ host: "8.8.8.8", port: 587 }, verified)).toMatchObject({
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      logger: false,
      debug: false,
    });
  });

  test("instanční SMTP zůstává beze změny", () => {
    expect(
      smtpOptions({ host: "smtp.example.cz", port: 587, auth: { user: "u", pass: "p" } }),
    ).toEqual({
      host: "smtp.example.cz",
      port: 587,
      secure: false,
      auth: { user: "u", pass: "p" },
      logger: false,
      debug: false,
    });
  });
});
