import { z } from "zod";

export const LogLevel = z.enum(["trace", "debug", "info", "warning", "error", "fatal"]);
export type LogLevel = z.infer<typeof LogLevel>;

const IanaTimezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid IANA timezone" },
);

const LogConfig = z.object({
  level: LogLevel.default("info"),
  console: z.enum(["pretty", "json", "off"]).default("pretty"),
  // Per-category levels, e.g. "robin.tdlib" = "debug"
  categories: z.record(z.string().regex(/^robin(\.[\w-]+)*$/), LogLevel).default({}),
  file: z
    .object({
      enabled: z.boolean().default(true),
      max_size_mb: z.number().positive().default(20),
      max_files: z.number().int().positive().default(10),
    })
    .prefault({}),
});

export const ConfigSchema = z.object({
  timezone: IanaTimezone.default("Asia/Shanghai"),
  data_dir: z.string().min(1).default("data"),
  log: LogConfig.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
