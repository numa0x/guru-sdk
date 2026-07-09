# Guru SDK

Standalone SDK package for Guru Protocol quote and transaction builders.

## Local Development With `guru.fund`

- During SDK or CLI development, use local `file:` links from `guru.fund` and `guru-cli` to this repo so changes can be smoke-tested before publishing.
- Rebuild this repo after SDK changes:
  `corepack pnpm build`
- Restart any long-running `guru.fund` dev/TRPC process after rebuilding; Node may keep the old SDK module in memory.
- Before committing/deploying `guru.fund`, replace local SDK links with the published npm version.

## Publishing

Use the repo-local publish helper, not bare `npm publish`:

```sh
NODE_AUTH_TOKEN=... node .local/npm-publish-public.mjs
```

The helper:

- publishes to `https://registry.npmjs.org/`
- requires `NODE_AUTH_TOKEN`
- checks that `name@version` does not already exist
- writes a temporary `.npmrc`
- publishes with `--access public`

Dry run:

```sh
NODE_AUTH_TOKEN=... node .local/npm-publish-public.mjs --dry-run
```

Release order when SDK and CLI both change:

1. Bump `@guru-fund/sdk` version.
2. Run SDK checks: `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm build`.
3. Publish SDK with `.local/npm-publish-public.mjs`.
4. Update `guru-cli` to depend on the new published SDK version, then build/publish CLI.
5. Update `guru.fund` package manifests from local `file:` links to the new published SDK version and refresh the lockfile.

The CLI repo also has `.local/npm-publish-public.mjs`. If pnpm blocks CLI
packing because the just-published SDK is inside the minimum release-age window,
build the CLI first and publish the already-built package with npm scripts
skipped.
