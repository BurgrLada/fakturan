import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  assertPublicHost,
  BlockedHostError,
  IMAP_PORTS,
  isPrivateAddress,
} from "@/server/mail/host-guard";
import { smtpOptions } from "@/server/mail/transport";

const dns = vi.hoisted(() => ({ records: [] as string[], code: "ENOTFOUND" }));

vi.mock("node:dns/promises", () => ({
  lookup: async (_host: string, opts: { all: boolean }) => {
    if (!opts.all) throw new Error("kontrola musí vidět všechny záznamy");
    if (dns.records.length === 0) throw Object.assign(new Error("DNS"), { code: dns.code });
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
  "::ffff:8.8.8.8",
  "::808:808",
  "::7f00:1",
  "64:ff9b::7f00:1",
  "64:ff9b::808:808",
  "64:ff9b:1::1",
  "2001::1",
  "2001:0:ffff::1",
  "2002:7f00:1::1",
  "2002:808:808::1",
  "fec0::1",
  "feff::1",
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
  "2001:1::1",
  "2001:4860:4860::8888",
  "2003::1",
  "64:ff9b:2::1",
  "::1:0:0:1",
];

const open = { allowPrivate: false };
const allowed = { allowPrivate: true };

beforeEach(() => {
  dns.records = ["8.8.8.8"];
  dns.code = "ENOTFOUND";
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

  test("trvale neexistující hostitel není dočasné selhání, EAI_AGAIN ano", async () => {
    dns.records = [];
    await expect(assertPublicHost("neni.example.cz", 587, open)).rejects.toMatchObject({
      temporary: false,
    });

    dns.code = "EAI_AGAIN";
    const error = await assertPublicHost("smtp.example.cz", 587, open).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockedHostError);
    expect(error).toMatchObject({ temporary: true, message: "Hostitel pošty není povolený" });

    dns.records = ["10.0.0.5"];
    await expect(assertPublicHost("smtp.example.cz", 587, open)).rejects.toMatchObject({
      temporary: false,
    });
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

describe("assertPublicHost pro IMAP", () => {
  const imap = { allowPrivate: false, ports: IMAP_PORTS };

  test.each(["10.0.0.5", "::ffff:127.0.0.1", "::ffff:7f00:1", "169.254.169.254"])(
    "[SEC-007] IMAP odmítne %s",
    async (address) => {
      dns.records = ["8.8.8.8", address];
      await expect(assertPublicHost("imap.example.cz", 993, imap)).rejects.toBeInstanceOf(
        BlockedHostError,
      );
    },
  );

  test("[SEC-007] port 22 je pro IMAP odmítnutý, 993 projde a SMTP dál neumí 993", async () => {
    expect(IMAP_PORTS).toEqual([143, 993]);
    await expect(assertPublicHost("imap.example.cz", 22, imap)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
    await expect(assertPublicHost("imap.example.cz", 587, imap)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
    await expect(assertPublicHost("imap.example.cz", 993, imap)).resolves.toEqual({
      address: "8.8.8.8",
      isPrivate: false,
    });
    await expect(assertPublicHost("imap.example.cz", 143, imap)).resolves.toMatchObject({
      isPrivate: false,
    });
    await expect(assertPublicHost("smtp.example.cz", 993, open)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
    await expect(assertPublicHost("smtp.example.cz", 143, open)).rejects.toBeInstanceOf(
      BlockedHostError,
    );
  });

  test("[SEC-007] výjimka pro privátní cíl zruší i omezení portů IMAP, veřejný cíl ho drží", async () => {
    dns.records = ["10.0.0.5"];
    await expect(
      assertPublicHost("mail.lan", 1143, { allowPrivate: true, ports: IMAP_PORTS }),
    ).resolves.toEqual({ address: "10.0.0.5", isPrivate: true });

    dns.records = ["8.8.8.8"];
    await expect(
      assertPublicHost("imap.example.cz", 1143, { allowPrivate: true, ports: IMAP_PORTS }),
    ).rejects.toBeInstanceOf(BlockedHostError);
  });

  test("dočasná chyba DNS zůstane dočasná i pro IMAP", async () => {
    dns.records = [];
    dns.code = "EAI_AGAIN";
    await expect(assertPublicHost("imap.example.cz", 993, imap)).rejects.toMatchObject({
      temporary: true,
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
