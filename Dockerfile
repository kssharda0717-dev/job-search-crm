# The proxy, and the migration runner, as one image.
#
# They share an image because they share a dependency tree and differ only in
# which command runs. They do not share a *container*: compose runs `migrate`
# to completion and only then starts `server`, so the long-running process
# never has `DATABASE_URL` in its environment (ADR-063).
#
# Node 22, not 20: `@supabase/supabase-js` prints a deprecation warning below
# that, and the extension toolchain is not installed here at all.
FROM node:22-slim

# corepack reads `packageManager` in the root package.json, so the image uses
# the same pnpm the lockfile was written with. A different pnpm can resolve a
# different tree from the same lockfile, which is the whole point of pinning.
RUN corepack enable

WORKDIR /app

# Manifests before sources. Editing a .ts file then rebuilds in seconds instead
# of reinstalling node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/

# `@crm/server...` — the trailing dots mean "and its workspace dependencies",
# which pulls in @crm/shared and leaves the extension's Plasmo toolchain out.
# That is most of the install, and none of it runs on a server.
#
# Dev dependencies are installed deliberately: `start` is `tsx src/index.ts`,
# so tsx *is* the runtime here. `--prod` would delete the thing that boots.
RUN pnpm install --frozen-lockfile --filter "@crm/server..."

COPY packages/shared packages/shared
COPY server server

# The migration runner reads these off disk at run time; without them the
# `migrate` service would find an empty directory and cheerfully report that
# there is nothing to apply.
COPY supabase/migrations supabase/migrations

# Everything above ran as root. Nothing below needs to write.
RUN chown -R node:node /app
USER node

EXPOSE 8787

# No curl in node:22-slim, and installing one to answer a health check is a
# poor trade. Node 22 has global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@crm/server", "start"]
