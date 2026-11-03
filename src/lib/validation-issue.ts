import type { z } from "zod";
import { TEXTS } from "./texts";

const C = TEXTS.dashboard.config;

type RawIssue = z.core.$ZodRawIssue;

function sized(issue: RawIssue, items: string, text: string, value: string): string {
  const origin = (issue as { origin?: string }).origin;
  if (origin === "array" || origin === "set") return items;
  if (origin === "string") return text;
  return value;
}

// Zod's default messages are English; a message set on the schema itself still wins over this map.
export function czechError(issue: RawIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined ? C.missing : C.invalidType;
    case "invalid_value":
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
      return C.invalidValue;
    case "unrecognized_keys":
      return C.unknownKey;
    case "too_small":
      return sized(issue, C.fewItems, C.textShort, C.tooSmall);
    case "too_big":
      return sized(issue, C.manyItems, C.textLong, C.tooBig);
    case "invalid_format":
      return C.invalidFormat;
    default:
      return C.invalidValue;
  }
}

function firstSegments(error: z.ZodError): { segments: PropertyKey[]; message: string } {
  const issue = error.issues[0];
  if (!issue) return { segments: [], message: C.invalidValue };
  const segments: PropertyKey[] = [...issue.path];
  if (issue.code === "unrecognized_keys") segments.push(issue.keys[0] ?? "");
  return { segments, message: issue.message };
}

export function firstIssue(error: z.ZodError): { path: string; message: string } {
  const { segments, message } = firstSegments(error);
  return { path: segments.map(String).join("."), message };
}

// The same first problem with array indexes in brackets, as a JSON file reads (R-25).
export function firstJsonIssue(error: z.ZodError): { path: string; message: string } {
  const { segments, message } = firstSegments(error);
  const path = segments.reduce<string>((out, segment) => {
    if (typeof segment === "number") return `${out}[${segment}]`;
    return out ? `${out}.${String(segment)}` : String(segment);
  }, "");
  return { path, message };
}

export function issueText(error: z.ZodError): string {
  const { path, message } = firstIssue(error);
  return path ? `${path}: ${message}` : message;
}
