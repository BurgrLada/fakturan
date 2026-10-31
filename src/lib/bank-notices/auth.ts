type AuthResult = "pass" | "fail" | "none";

type Statement = { method: string; result: string; properties: [string, string][] };

const DOMAIN_PROPERTIES = new Map([
  ["dkim", ["header.d", "header.i"]],
  ["spf", ["smtp.mailfrom"]],
  ["dmarc", ["header.from"]],
]);

const UNFOLDED_BREAK = /[\r\n](?![\r\n \t])/;

function pair(token: string): [string, string] {
  const equals = token.indexOf("=");
  return [token.slice(0, equals), token.slice(equals + 1)];
}

// RFC 8601 comments and quoted strings may carry text from the sender's message, so
// a plain split on ";" would let them forge a result. Returns null when malformed; a comma
// outside them means duplicate headers were joined, which would revive a forged lower one.
function splitStatements(header: string): string[] | null {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const char = header[i]!;
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') quoted = false;
      else if (!/\s/.test(char)) current += char;
    } else if (depth > 0) {
      if (char === "\\") i++;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    } else if (char === ")" || char === ",") {
      return null;
    } else if (char === "(") {
      depth = 1;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ";") {
      statements.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  return quoted || depth > 0 ? null : [...statements, current];
}

function toStatement(text: string): Statement {
  const [first, ...rest] = text.trim().split(/\s+/);
  const [method, result] = pair(first!);
  return { method, result, properties: rest.map(pair) };
}

function inDomain(value: string, domain: string): boolean {
  const host = value.slice(value.lastIndexOf("@") + 1);
  return host === domain || host.endsWith(`.${domain}`);
}

function passesFor({ method, result, properties }: Statement, domain: string): boolean {
  const names = DOMAIN_PROPERTIES.get(method)!;
  const values = properties.filter(([name]) => names.includes(name));
  return (
    result === "pass" && values.length > 0 && values.every(([, value]) => inDomain(value, domain))
  );
}

// topHeader must be the highest Authentication-Results, the one the recipient's server
// added. Anything below it can come from the sender.
export function checkAuthResults(topHeader: string | null, domain: string): AuthResult {
  if (!topHeader) return "none";
  if (UNFOLDED_BREAK.test(topHeader)) return "fail";
  const parts = splitStatements(topHeader.toLowerCase());
  if (!parts) return "fail";
  const texts = parts
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean);
  if (texts.length === 1 && texts[0] === "none") return "none";
  // A token without "=" here can only be a second authserv-id or broken syntax.
  if (texts.some((text) => text.split(/\s+/).some((token) => !token.includes("=")))) return "fail";
  const statements = texts.map(toStatement).filter(({ method }) => DOMAIN_PROPERTIES.has(method));
  if (statements.some((statement) => passesFor(statement, domain.toLowerCase()))) return "pass";
  return statements.every(({ result }) => result === "none") ? "none" : "fail";
}
