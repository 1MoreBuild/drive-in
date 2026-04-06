# Releasing to npm with OIDC

This repository publishes to npm using GitHub Actions OIDC (trusted publishing), without `NPM_TOKEN`.

## One-time setup

1. Go to npm package settings for `@drive-in/cli`.
2. Add a trusted publisher:
   - Provider: `GitHub Actions`
   - Repository: `1MoreBuild/drive-in`
   - Workflow filename: `release-cli.yml`
   - Environment name: `npm`
3. In GitHub repository settings, create environment `npm` (optional but recommended for protection rules).
4. Remove old npm token secrets from GitHub (e.g. `NPM_TOKEN`) to avoid fallback to legacy auth.

## Workflow behavior

Workflow file: `.github/workflows/release-cli.yml`

- Trigger: GitHub Release `published`
- Required permissions:
  - `contents: read`
  - `id-token: write`
- Steps:
  - install dependencies
  - publish with `npm publish --access public -w cli`
- Safety check: release tag must equal `v${cli/package.json version}`.
- Safety check: release tag commit must be on `main` branch history.

## Release steps

1. Bump version locally: `npm version patch|minor|major -w cli`
2. Push commit and tag: `git push && git push --tags`
3. Create and publish a GitHub Release from that tag.
4. GitHub Actions publishes to npm automatically.
