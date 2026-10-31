import "server-only";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const ALLOWED_PORTS = new Set([25, 465, 587, 2525]);

const V4_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const V6_RANGES: [string, number][] = [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

// Two lists: one BlockList would match plain IPv4 addresses against ::ffff:0:0/96.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of V4_RANGES) blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of V6_RANGES) blockedV6.addSubnet(network, prefix, "ipv6");

export class BlockedHostError extends Error {
  // A DNS outage may pass, so delivery can retry; users see the same refusal either way.
  temporary: boolean;

  constructor(temporary = false) {
    super("Hostitel pošty není povolený");
    this.name = "BlockedHostError";
    this.temporary = temporary;
  }
}

export function isPrivateAddress(ip: string): boolean {
  const address = ip.split("%")[0];
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  return family === 6 ? blockedV6.check(address, "ipv6") : true;
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const records = await lookup(host, { all: true });
    return records.map((record) => record.address);
  } catch (error) {
    throw new BlockedHostError((error as { code?: string }).code === "EAI_AGAIN");
  }
}

export async function assertPublicHost(
  host: string,
  port: number,
  opts: { allowPrivate: boolean },
): Promise<{ address: string; isPrivate: boolean }> {
  const addresses = await resolveAll(host);
  const [address] = addresses;
  if (!address) throw new BlockedHostError();
  if (!opts.allowPrivate && addresses.some(isPrivateAddress)) throw new BlockedHostError();
  // The caller connects to this one address, so it alone decides which limits the exception lifts.
  const isPrivate = isPrivateAddress(address);
  if (!isPrivate && !ALLOWED_PORTS.has(port)) throw new BlockedHostError();
  return { address, isPrivate };
}
