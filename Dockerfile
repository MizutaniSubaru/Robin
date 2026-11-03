# Runs the TypeScript sources directly with Bun, no compile step.
# TDLib is added in M1.
FROM oven/bun:1.3.11-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
# Applied at startup by runMigrations
COPY migrations ./migrations

# Mount config.toml at /app/config.toml and persist /app/data
RUN mkdir -p data && chown bun:bun data
VOLUME /app/data
USER bun

CMD ["bun", "src/main.ts"]
