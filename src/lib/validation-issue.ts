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

// The JSON path of the first problem and what is wrong with it (R-25).
export function firstIssue(error: z.ZodError): { path: string; message: string } {
  const issue = error.issues[0];
  if (!issue) return { path: "", message: C.invalidValue };
  const path = issue.path.map(String);
  if (issue.code === "unrecognized_keys") path.push(issue.keys[0] ?? "");
  return { path: path.join("."), message: issue.message };
}

export function issueText(error: z.ZodError): string {
  const { path, message } = firstIssue(error);
  return path ? `${path}: ${message}` : message;
}
