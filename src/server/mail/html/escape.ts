import { TYPE } from "./tokens";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char]!);
}

// No autolinking: a URL in the message stays text, so nothing in the HTML can be followed (MAIL-007).
export function paragraphs(text: string, style: string = TYPE.paragraph): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block.trim() !== "")
    .map((block) => `<p style="${style}">${block.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}
