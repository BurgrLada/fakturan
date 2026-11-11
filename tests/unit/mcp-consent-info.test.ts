import { describe, expect, test } from "vitest";
import { consentInfo } from "@/server/mcp/consent-info";

const LOCAL = "aplikace na tomto počítači";

describe("consentInfo", () => {
  test("[MCP-044] loopback ukáže místo hostitele aplikaci na tomto počítači", () => {
    for (const redirectUri of [
      "http://127.0.0.1:5555/cb",
      "http://localhost/cb",
      "http://[::1]:8080/cb",
    ]) {
      expect(consentInfo({ clientName: "Claude Code", redirectUri, clientIdUrl: null })).toEqual({
        name: "Claude Code",
        host: LOCAL,
        nameIsClaimed: true,
      });
    }
  });

  test("[MCP-044] CIMD ukáže hostitele dokumentu, jinak hostitele redirect_uri", () => {
    expect(
      consentInfo({
        clientName: "Claude",
        redirectUri: "https://example.com/api/mcp/auth_callback",
        clientIdUrl: "https://claude.ai/oauth/mcp.json",
      }).host,
    ).toBe("claude.ai");
    expect(
      consentInfo({
        clientName: "Claude",
        redirectUri: "https://chatgpt.com/connector/oauth/abc",
        clientIdUrl: null,
      }).host,
    ).toBe("chatgpt.com");
  });

  test("[MCP-005] dlouhý a prázdný název", () => {
    const long = consentInfo({
      clientName: "Ř".repeat(200),
      redirectUri: "http://127.0.0.1/cb",
      clientIdUrl: null,
    });
    expect([...long.name].length).toBeLessThanOrEqual(80);
    expect(long.name.startsWith("ŘŘŘ")).toBe(true);
    for (const clientName of [null, "", "   \n\t "]) {
      expect(
        consentInfo({ clientName, redirectUri: "http://127.0.0.1/cb", clientIdUrl: null }).name,
      ).toBe("Neznámá aplikace");
    }
  });

  test("[MCP-005] HTML v názvu se vrací jako text, nic se neparsuje", () => {
    const name = '<img src=x onerror="alert(1)"> Asistent &amp; spol.';
    expect(
      consentInfo({ clientName: name, redirectUri: "http://127.0.0.1/cb", clientIdUrl: null }).name,
    ).toBe(name);
  });
});
