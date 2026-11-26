# Contributing

## Set up

With Nix, `nix develop` provides Node.js 24 and the Playwright browsers. Without Nix, install Node.js 24 or newer and run `npx playwright install chromium` once.

```sh
npm ci
npm run dev
```

`npm run dev` serves a demo with simulated VMs at <http://localhost:3000>, with its own database in `data/demo.sqlite`.

To work against a real Proxmox, copy `.env.example` to `.env.local`, fill in `APP_ORIGIN` (such as `http://localhost:3000`) and the [Proxmox settings](docs/proxmox.md). Then create an administrator and start the server:

```sh
npm run proxdesk -- create-admin --email admin@example.com
npm run dev:live
```

## Check a change

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Changes to packaging also need `nix flake check`, which builds the package and boots the NixOS module in a VM test.

`@playwright/test` is pinned to the Playwright version in the flake's nixpkgs. Update both together.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), such as `fix(console): close sockets when access is revoked`. Releases and the changelog are generated from them, so `feat` and `fix` describe user-visible changes. Mark breaking changes with `!` after the type.

Keep each pull request to one change, and include tests for behavior changes.
