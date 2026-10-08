# Changelog

Notable changes per release. The per-commit detail is auto-generated into each
[GitHub Release](https://github.com/kssharda0717-dev/job-search-crm/releases);
this file is the version of events worth reading.

Versions are `MAJOR.MINOR.PATCH`, and the server image and the extension always
share one. They are two halves of one system that talk to each other over a
private protocol, so versioning them independently would only create a
compatibility matrix nobody maintains.

A **MAJOR** bump means the extension and server must be updated together. A
**MINOR** bump means a new migration ships, so the update has to go through
`docker compose up` — which runs `migrate` first — rather than restarting the
server container on its own.

## 1.0.0

First tagged release. Everything below already worked; this is the point at
which it became installable without a developer toolchain.

### Added

- **Published server image.** `ghcr.io/kssharda0717-dev/job-search-crm`, built
  for `linux/amd64` and `linux/arm64` by
  [`.github/workflows/release.yml`](.github/workflows/release.yml) from the
  tagged commit. `docker compose up -d` now downloads it instead of compiling
  the dependency tree on the user's machine.
- **Prebuilt extension.** Each release carries
  `job-search-crm-extension-v<version>.zip`. Installing no longer requires Node
  or pnpm — unzip it and load the folder unpacked.
- **`docker-compose.build.yml`**, for building from source instead of pulling.
- **Tag/manifest version check** in the release workflow. A tag whose number
  disagrees with `package.json` fails rather than shipping an extension that
  misreports its own version.

### Notes

- The release job re-runs `pnpm verify` against the tagged commit rather than
  trusting the earlier CI run, because a tag can point at a commit no branch
  ever built.
- There is still **no automatic update**. Updating is one command for the
  server and one Reload click for the extension; see README → Updating. An
  image-watcher that restarts containers by itself would skip the `migrate`
  step and quietly run new code against an old schema.
