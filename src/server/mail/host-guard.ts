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
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const blocked = new BlockList();
for (const [network, prefix] of V4_RANGES) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of V6_RANGES) blocked.addSubnet(network, prefix, "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addAddress("::", "ipv6");

export class BlockedHostError extends Error {
  constructor() {
    super("Hostitel pošty není povolený");
    this.name = "BlockedHostError";
  }
}

function unwrapMapped(address: string): string {
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isPrivateAddress(ip: string): boolean {
  const address = ip.split("%")[0];
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const plain = unwrapMapped(address);
  return isIP(plain) === 4 ? blocked.check(plain, "ipv4") : blocked.check(plain, "ipv6");
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const records = await lookup(host, { all: true });
    return records.map((record) => record.address);
  } catch {
    throw new BlockedHostError();
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
