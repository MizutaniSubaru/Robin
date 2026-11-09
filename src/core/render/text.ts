import type { ContentPart, TextEntity } from "../events/index.ts";
import { attrs, escapeText } from "./xml.ts";

// Resolves a user key to the short alias shown to the model
export type AliasOf = (user: string) => string;

// Only formatting that changes meaning is shown; bold, italic and the like are dropped as noise.
// undefined: shown as plain text
function markers(entity: TextEntity, aliasOf: AliasOf): [open: string, close: string] | undefined {
  switch (entity.type) {
    case "bold":
    case "italic":
    case "underline":
    case "strikethrough":
    // Already literal "@username" text
    case "mention":
      return undefined;
    case "code":
      return ["`", "`"];
    case "pre":
      return [`\`\`\`${entity.language}\n`, "\n```"];
    case "text_url":
      return [`<link${attrs({ url: entity.url })}>`, "</link>"];
    case "mention_user":
      return [`<mention${attrs({ user: aliasOf(entity.user) })}>`, "</mention>"];
    case "spoiler":
      return ["<spoiler>", "</spoiler>"];
    case "blockquote":
      return ["<blockquote>", "</blockquote>"];
  }
}

// Text with its entities as markup. Platforms nest entities properly; one that crosses another is
// shown as plain text rather than producing broken markup
export function renderFormatted(text: string, entities: readonly TextEntity[], aliasOf: AliasOf): string {
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
  const stack: { end: number; close: string }[] = [];
  let out = "";
  let pos = 0;

  const closeUntil = (offset: number) => {
    for (let top = stack.at(-1); top && top.end <= offset; top = stack.at(-1)) {
      out += escapeText(text.slice(pos, top.end)) + top.close;
      pos = top.end;
      stack.pop();
    }
  };

  for (const entity of sorted) {
    const shown = markers(entity, aliasOf);
    if (!shown) continue;
    closeUntil(entity.offset);
    const end = entity.offset + entity.length;
    const parent = stack.at(-1);
    if (parent && end > parent.end) continue;
    const [open, close] = shown;
    out += escapeText(text.slice(pos, entity.offset)) + open;
    pos = entity.offset;
    stack.push({ end, close });
  }
  closeUntil(Number.POSITIVE_INFINITY);
  return out + escapeText(text.slice(pos));
}

export function renderContent(content: readonly ContentPart[], aliasOf: AliasOf): string {
  return content.map((part) => renderPart(part, aliasOf)).join("");
}

function renderPart(part: ContentPart, aliasOf: AliasOf): string {
  switch (part.type) {
    case "text":
      return renderFormatted(part.text, part.entities, aliasOf);
    case "sticker":
      return `<sticker${attrs({ emoji: part.emoji })}/>`;
    case "unsupported":
      return `<unsupported${attrs({ kind: part.kind })}/>`;
  }
}
