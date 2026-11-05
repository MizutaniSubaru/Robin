import { describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config/index.ts";

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
