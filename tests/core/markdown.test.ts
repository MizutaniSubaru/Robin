import { describe, expect, test } from "bun:test";

import { parseMarkdown } from "../../src/core/markdown/index.ts";

describe("parseMarkdown", () => {
  test("inline styles, code and links", () => {
    expect(parseMarkdown("**bold** and *it* `x*y` [docs](https://a.b) ~~no~~ ||sp||")).toEqual({
      text: "bold and it x*y docs no sp",
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 9, length: 2 },
        { type: "code", offset: 12, length: 3 },
        { type: "text_url", url: "https://a.b", offset: 16, length: 4 },
        { type: "strikethrough", offset: 21, length: 2 },
        { type: "spoiler", offset: 24, length: 2 },
      ],
    });
  });

  test("nested styles count UTF-16 units", () => {
    expect(parseMarkdown("😀 **a _b_**")).toEqual({
      text: "😀 a b",
      entities: [
        { type: "bold", offset: 3, length: 3 },
        { type: "italic", offset: 5, length: 1 },
      ],
    });
  });

  test("fenced code, quotes and headings", () => {
    expect(parseMarkdown("# Title\n```ts\nconst a = 1;\n```\n> one\n> **two**\nend")).toEqual({
      text: "Title\nconst a = 1;\none\ntwo\nend",
      entities: [
        { type: "bold", offset: 0, length: 5 },
        { type: "pre", language: "ts", offset: 6, length: 12 },
        { type: "blockquote", offset: 19, length: 7 },
        { type: "bold", offset: 23, length: 3 },
      ],
    });
  });

  test("leaves what is not Markdown alone", () => {
    for (const literal of ["snake_case_name", "2 * 3 * 4", "a ** b", "unclosed `tick", "[x] (y)"]) {
      expect(parseMarkdown(literal)).toEqual({ text: literal, entities: [] });
    }
    expect(parseMarkdown("\\*not italic\\*")).toEqual({ text: "*not italic*", entities: [] });
  });
});
