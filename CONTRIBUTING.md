# Contributing

Thanks for looking at this. Before opening a PR, please read
[`docs/RULES.md`](docs/RULES.md) — it is the actual rulebook, and this file is
only the parts you need to get a change compiling and reviewed.

## Setup

See [`README.md`](README.md) → **From source** — not → Install, which pulls a
published image and would hide your changes. The short version:

```bash
pnpm install
cp server/.env.example server/.env   # fill in your own keys
pnpm --filter @crm/server dev        # http://127.0.0.1:8787
pnpm --filter @crm/extension dev     # load extension/build/chrome-mv3-dev unpacked
```

To exercise the container path against your own code rather than the registry:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml \
  --env-file server/.env up -d --build
```

Plain `docker compose up` pulls `ghcr.io/kssharda0717-dev/job-search-crm` and
will run the last release, not your working tree. That is why `docker-compose.yml`
has no `build:` key — Compose prefers building over pulling whenever both are
present, which would make every user compile the dependency tree.

You need your own Supabase project and OpenAI key. There is no shared
development backend, and there is no hosted mode — the server binds to loopback
and holds a service-role key that bypasses RLS.

## Before you push

```bash
pnpm verify
```

That is `pnpm -r typecheck`, the server test suite (`node:test`), and the
extension production build. CI runs exactly this, plus one extra check.

**That extra check matters more than it looks.** A content script that imports
the `@crm/shared` barrel pulls zod into its bundle, Parcel stubs it, and the
script dies at load — while typecheck, the build and the side panel all stay
green. Every scraper silently stops running and nothing says so. Runtime values
a content script needs must come from a zod-free subpath
(`@crm/shared/constants`, `/profile-text`, `/vault`, `/job-title`), never the
barrel. CI greps the content-script bundles for `zod`; so should you.

## What not to run

`pnpm verify:release` additionally runs both evals. They **spend real OpenAI
credit** and seed and tear down a throwaway job in a **live** Supabase project.
They are a release gate, not a pre-commit hook.

If an eval fails a floor in `server/src/eval/gates.ts`, fix the regression.
Never lower a floor to make a run pass.

## Releasing

Maintainers only. Pushing a `v*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which re-runs
`pnpm verify` against the tagged commit, pushes a multi-architecture image to
GHCR, and attaches the built extension to a GitHub Release.

The version lives in three places and the workflow fails if they disagree: the
tag, `package.json`, and `extension/package.json`. Bump the two files in the
same commit you tag, add a `CHANGELOG.md` entry, and run `pnpm verify:release`
by hand first — the tag job does not spend credit on the evals.

## Writing the change

A few rules that reviewers will hold you to, pulled from `docs/RULES.md`:

- **Comments explain *why*, never *what*.** This codebase's comments record the
  failure that motivated the code. Preserve that style. A comment restating the
  line below it will be asked for removal.
- **Read before you write.** Do not propose a change to a file you have not
  read; do not add a helper before grepping for one that exists.
- **Delete rather than deprecate.** No `_unused` renames, no re-exported dead
  types, no `// removed` markers.
- **Pure logic goes in its own file.** `rag/embeddings.ts` builds the OpenAI
  client from `env` at module load and `env` throws at import, so anything in
  that import graph is unreachable from a unit test. Extract the logic; never
  mock `env`.
- **Migrations are append-only.** Never edit one that has been run. Add the new
  file, and add its row to the table in `README.md` with the consequence of
  skipping it.

## Testing

`node:test` under `server/test/`, run by `pnpm --filter @crm/server test`. The
extension has no test runner, which is why logic that *looks* like it belongs to
the extension (`profile-text.ts`, `vault.ts`, `job-title.ts`) lives in
`packages/shared` instead — so it can be tested at all.

A test should pin the behaviour and say which failure it exists for. Several
suites quote a real draft that shipped; that is the register to aim for.

## Reporting a bug

Please say which of the three processes it is in (server, extension content
script, extension worker), and for anything involving LinkedIn capture, check
`chrome://extensions` → Errors first. A dead content script looks exactly like a
working one from the outside.

## Security

Do not open a public issue for a security problem. See
[`SECURITY.md`](SECURITY.md).

## Data in issues and PRs

This is a tool for handling résumés and real people's LinkedIn profiles. Do not
paste a real résumé, a real profile, a real recruiter's name, or anything from
your own `.env` into an issue, a PR or a test fixture. The fixtures in this repo
use a fictional cast on purpose — extend it rather than replacing it with
something real.
