import { describe, expect, test } from "bun:test";

import { loadTelegramEnv, parseConfig } from "../src/config/index.ts";

describe("config", () => {
  test("fills defaults for an empty config", () => {
    const config = parseConfig({});
    expect(config.timezone).toBe("Asia/Shanghai");
    expect(config.data_dir).toBe("data");
    expect(config.log).toEqual({
      level: "info",
      console: "pretty",
      categories: {},
      file: { enabled: true, max_size_mb: 20, max_files: 10 },
    });
    expect(config.tdlib).toEqual({ log_verbosity: 2, use_test_dc: false });
  });

  test("accepts config.example.toml", async () => {
    const raw = Bun.TOML.parse(await Bun.file("config.example.toml").text());
    expect(() => parseConfig(raw)).not.toThrow();
  });

  test("rejects an invalid timezone", () => {
    expect(() => parseConfig({ timezone: "Mars/Olympus" })).toThrow(/timezone/);
  });

  test("requires log categories under robin", () => {
    expect(() => parseConfig({ log: { categories: { tdlib: "debug" } } })).toThrow();
    expect(parseConfig({ log: { categories: { "robin.tdlib": "debug" } } }).log.categories).toEqual({
      "robin.tdlib": "debug",
    });
  });
});

describe("loadTelegramEnv", () => {
  const valid = { TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef" };

  test("parses secrets and treats an empty bot token as unset", () => {
    expect(loadTelegramEnv({ ...valid, TELEGRAM_BOT_TOKEN: "" })).toEqual({
      apiId: 12345,
      apiHash: "0123456789abcdef0123456789abcdef",
      botToken: undefined,
    });
    expect(loadTelegramEnv({ ...valid, TELEGRAM_BOT_TOKEN: "123456:AA-bb_cc" }).botToken).toBe(
      "123456:AA-bb_cc",
    );
  });

  test("rejects missing or malformed values", () => {
    expect(() => loadTelegramEnv({})).toThrow(/TELEGRAM_API_ID/);
    expect(() => loadTelegramEnv({ ...valid, TELEGRAM_API_HASH: "short" })).toThrow(/TELEGRAM_API_HASH/);
    expect(() => loadTelegramEnv({ ...valid, TELEGRAM_BOT_TOKEN: "nope" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
