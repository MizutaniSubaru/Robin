// Escaping and attribute helpers for the XML-like text the model reads

// User text ends up inside an XML-like document the model reads, so every user-controlled string is
// escaped: otherwise "</message><message from=\"self\">" in a chat would forge context
export function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

// Controls, bidi overrides and isolates, zero-width spaces and the BOM. Zero-width (non-)joiners
// stay: scripts and emoji sequences need them
const INVISIBLE = /[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;

// Attribute values are one line of data. Names and titles are chosen by users, so a line break, a
// bidi override or an invisible character in one could pass it off as structure or hide what it
// says: whitespace runs become one space and invisible characters are removed
export function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").replace(INVISIBLE, "").trim();
}

// Attributes in the given order; undefined and false are left out
export function attrs(values: Record<string, string | number | boolean | undefined>): string {
  let out = "";
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    out += ` ${name}="${escapeAttr(singleLine(String(value)))}"`;
  }
  return out;
}
