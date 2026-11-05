import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "../src/config/index.ts";
import { getLogger, setupLogging, shutdownLogging, withContext } from "../src/log/index.ts";

let dir: string;
let lines: Record<string, unknown>[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "robin-log-"));
  const config = parseConfig({
    log: { level: "info", console: "off", categories: { "robin.tdlib": "debug", "robin.llm": "error" } },
  });
  await setupLogging(config.log, dir);

  withContext({ chat: "tg:-100123", run_id: "r1" }, () => {
    getLogger("agent").info("run started");
  });
  getLogger("agent").debug("dropped: below global level");
  getLogger("tdlib").debug("kept: category override");
  getLogger("llm").warn("dropped: category raised to error");
  getLogger("adapter").info("login with {apiKey}", { apiKey: "sk-ant-abcdefghijklmnopqrstuvwxyz" });
  getLogger("adapter").info("token in text 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq");

  await shutdownLogging();
  lines = readFileSync(join(dir, "robin.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("adds implicit context to properties", () => {
  expect(lines[0]).toMatchObject({ logger: "robin.agent", properties: { chat: "tg:-100123", run_id: "r1" } });
});

test("applies per-category levels", () => {
  const messages = lines.map((l) => l.message);
  expect(messages).toContain("kept: category override");
  expect(messages).not.toContain("dropped: below global level");
  expect(messages).not.toContain("dropped: category raised to error");
});

test("redacts secrets", () => {
  const text = JSON.stringify(lines);
  expect(text).not.toContain("sk-ant-");
  expect(text).not.toContain("AAHdqTcv");
  expect(text).toContain("[REDACTED]");
});
