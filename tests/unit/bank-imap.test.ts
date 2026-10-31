import { describe, expect, test } from "vitest";
import { classifyImapError, IMAP_TIMEOUTS, imapOptions } from "@/server/bank/imap";
import { BlockedHostError } from "@/server/mail/host-guard";

const settings = {
  host: "imap.example.cz",
  port: 993,
  tls: "implicit" as const,
  username: "avizo",
  password: "tajne",
  folder: "INBOX",
};
const publicTarget = { address: "8.8.8.8", isPrivate: false };

describe("imapOptions", () => {
  test("[SEC-007] spojení jde na ověřenou IP se servername původního hostitele", () => {
    expect(imapOptions(settings, publicTarget)).toMatchObject({
      host: "8.8.8.8",
      port: 993,
      secure: true,
      servername: "imap.example.cz",
    });
  });

  test("[SEC-007] ověření certifikátu se nikdy nevypíná", () => {
    for (const tls of ["implicit", "starttls"] as const) {
      for (const isPrivate of [true, false]) {
        const options = imapOptions({ ...settings, tls }, { address: "8.8.8.8", isPrivate });
        expect(options.tls).toBeUndefined();
        expect(JSON.stringify(options)).not.toContain("rejectUnauthorized");
      }
    }
  });

  test("[SEC-007] STARTTLS je povinný pro veřejný cíl, pro privátní ne", () => {
    const starttls = { ...settings, port: 143, tls: "starttls" as const };
    expect(imapOptions(starttls, publicTarget)).toMatchObject({ secure: false, doSTARTTLS: true });
    const priv = imapOptions(starttls, { address: "10.0.0.5", isPrivate: true });
    expect(priv.secure).toBe(false);
    expect(priv.doSTARTTLS).toBeUndefined();
    expect(imapOptions(settings, publicTarget).doSTARTTLS).toBeUndefined();
  });

  test("hostitel zadaný jako IP nedostane servername", () => {
    expect(imapOptions({ ...settings, host: "8.8.8.8" }, publicTarget).servername).toBeUndefined();
  });

  test("logger je vypnutý, aby se heslo nedostalo do logu, a časové limity jsou krátké", () => {
    const options = imapOptions(settings, publicTarget);
    expect(options.logger).toBe(false);
    expect(options).toMatchObject(IMAP_TIMEOUTS);
    expect(IMAP_TIMEOUTS.socketTimeout).toBeLessThan(60_000);
  });
});

describe("classifyImapError", () => {
  test.each([
    [new BlockedHostError(), "blocked_host"],
    [new BlockedHostError(true), "timeout"],
    [Object.assign(new Error("x"), { authenticationFailed: true }), "auth"],
    [Object.assign(new Error("x"), { serverResponseCode: "AUTHENTICATIONFAILED" }), "auth"],
    [Object.assign(new Error("x"), { tlsFailed: true }), "tls"],
    [Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "tls"],
    [Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "tls"],
    [Object.assign(new Error("x"), { code: "ClosedAfterConnectTLS" }), "tls"],
    [Object.assign(new Error("x"), { code: "CONNECT_TIMEOUT" }), "timeout"],
    [Object.assign(new Error("x"), { code: "GREETING_TIMEOUT" }), "timeout"],
    [Object.assign(new Error("x"), { code: "ETIMEOUT" }), "timeout"],
    [Object.assign(new Error("x"), { mailboxMissing: true }), "folder"],
    [Object.assign(new Error("x"), { serverResponseCode: "NONEXISTENT" }), "folder"],
    [Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "other"],
    [new Error("cokoliv"), "other"],
    ["text", "other"],
    [null, "other"],
    [undefined, "other"],
  ])("%#: %s", (error, code) => {
    expect(classifyImapError(error)).toBe(code);
  });

  test("výsledek je jen kód, nikdy text serveru", () => {
    const error = Object.assign(new Error("tajne-heslo je spatne"), {
      authenticationFailed: true,
      responseText: "tajne-heslo je spatne",
    });
    expect(classifyImapError(error)).toBe("auth");
  });
});
