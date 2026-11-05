# Runs the TypeScript sources directly with Bun, no compile step.
# TDLib comes from prebuilt-tdlib (pinned in package.json, statically linked against OpenSSL and zlib,
# needs glibc >= 2.22). bun install picks the build for the image's architecture.
# If TDLib ever needs patching (reply_to or reactions on unseen messages), add a build stage and set tdlib.library_path
FROM oven/bun:1.3.11-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
  # Fail the build here rather than at startup if no TDLib build matches this platform
  && bun -e 'const { getTdjson, getTdlibInfo } = require("prebuilt-tdlib"); require("node:fs").accessSync(getTdjson()); console.error("TDLib", getTdlibInfo().version)'

COPY src ./src
# Applied at startup by runMigrations
COPY migrations ./migrations

# Mount config.toml at /app/config.toml and persist /app/data (it holds the TDLib sessions)
RUN mkdir -p data && chown bun:bun data && chmod 700 data
VOLUME /app/data
USER bun

CMD ["bun", "src/main.ts"]
