// The Markdown the model writes, turned into plain text plus entities, which is how chat platforms
// take formatted text. Having the model write a platform's own markup instead (Telegram MarkdownV2)
// fails on its escaping rules; anything this parser does not recognise simply stays literal text.
//
// Blocks: ``` fenced code ```, > quotes, # headings (shown bold). Inline: `code`, **bold**, __bold__,
// *italic*, _italic_, ~~strike~~, ||spoiler||, [text](url), and backslash escapes
import type { TextEntity } from "../events/index.ts";

export interface FormattedText {
  text: string;
  entities: TextEntity[];
}

type Style = "bold" | "italic" | "strikethrough" | "spoiler";

// Longest delimiters first, so ** is not read as two *
const DELIMITERS: readonly { token: string; style: Style }[] = [
  { token: "**", style: "bold" },
  { token: "__", style: "bold" },
  { token: "~~", style: "strikethrough" },
  { token: "||", style: "spoiler" },
  { token: "*", style: "italic" },
  { token: "_", style: "italic" },
];

const ESCAPABLE = new Set("\\`*_~|[]()>#".split(""));

export function parseMarkdown(markdown: string): FormattedText {
  const out = createBuilder();
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i > 0) out.text("\n");

    const fence = /^```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l));
      if (end !== -1) {
        out.span({ type: "pre", language: fence[1] ?? "" }, () =>
          out.text(lines.slice(i + 1, end).join("\n")),
        );
        i = end;
        continue;
      }
    }

    if (/^>\s?/.test(line)) {
      let end = i;
      while (end + 1 < lines.length && /^>\s?/.test(lines[end + 1] ?? "")) end++;
      const quoted = lines.slice(i, end + 1).map((l) => l.replace(/^>\s?/, ""));
      out.span({ type: "blockquote" }, () => {
        quoted.forEach((q, k) => {
          if (k > 0) out.text("\n");
          parseInline(q, out);
        });
      });
      i = end;
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.span({ type: "bold" }, () => parseInline(heading[1] ?? "", out));
      continue;
    }

    parseInline(line, out);
  }
  return out.result();
}

function parseInline(source: string, out: Builder): void {
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";

    if (ch === "\\" && ESCAPABLE.has(source[i + 1] ?? "")) {
      out.text(source[i + 1] ?? "");
      i += 2;
      continue;
    }

    if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        out.span({ type: "code" }, () => out.text(source.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const link = /^\[([^\]]+)\]\(([^()\s]+)\)/.exec(source.slice(i));
      if (link) {
        out.span({ type: "text_url", url: link[2] ?? "" }, () => parseInline(link[1] ?? "", out));
        i += link[0].length;
        continue;
      }
    }

    const styled = matchDelimited(source, i);
    if (styled) {
      out.span({ type: styled.style }, () => parseInline(styled.inner, out));
      i = styled.next;
      continue;
    }

    out.text(ch);
    i++;
  }
}

function matchDelimited(
  source: string,
  i: number,
): { style: Style; inner: string; next: number } | undefined {
  for (const { token, style } of DELIMITERS) {
    if (!source.startsWith(token, i)) continue;
    const start = i + token.length;
    // Emphasis must hug its text: "a * b" is not italic
    if (/\s/.test(source[start] ?? " ")) return undefined;
    // snake_case_words are not italic
    if (token === "_" && /\w/.test(source[i - 1] ?? "")) return undefined;
    let end = source.indexOf(token, start);
    while (end !== -1) {
      const closesWord = !/\s/.test(source[end - 1] ?? " ");
      const wordAfter = token === "_" && /\w/.test(source[end + token.length] ?? "");
      if (end > start && closesWord && !wordAfter) {
        return { style, inner: source.slice(start, end), next: end + token.length };
      }
      end = source.indexOf(token, end + 1);
    }
    return undefined;
  }
  return undefined;
}

// An entity without its position, which span() fills in
type EntityKind = TextEntity extends infer E
  ? E extends unknown
    ? Omit<E, "offset" | "length">
    : never
  : never;

interface Builder {
  text(value: string): void;
  span(entity: EntityKind, body: () => void): void;
  result(): FormattedText;
}

function createBuilder(): Builder {
  let text = "";
  const entities: TextEntity[] = [];
  return {
    text(value) {
      text += value;
    },
    span(entity, body) {
      const offset = text.length;
      body();
      const length = text.length - offset;
      // Entities in document order: an outer entity before the ones inside it
      if (length > 0) entities.push({ ...entity, offset, length } as TextEntity);
    },
    result() {
      return { text, entities: entities.sort((a, b) => a.offset - b.offset || b.length - a.length) };
    },
  };
}
