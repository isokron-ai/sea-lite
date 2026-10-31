# Contributing to sea-lite

Thanks for taking a look. sea-lite is small on purpose; contributions that
keep it small are the most welcome.

## Ground rules

- **Apache-2.0.** By contributing you agree your contribution is licensed
  under the Apache License 2.0 (see `LICENSE`).
- **Developer Certificate of Origin (DCO).** Every commit must be signed off
  (`git commit -s`), which adds a `Signed-off-by:` trailer certifying the
  [DCO 1.1](https://developercertificate.org/): you wrote the change or have
  the right to submit it under the project's license. Unsigned commits will
  be asked to be re-pushed with sign-off.
- **No secrets, ever.** No keys, tokens, `.env` files, database URLs or
  fixtures containing real credentials.
- **The projection must stay replayable.** Any change to what a handler
  writes to a row must be mirrored in `src/rebuild.ts`; the
  rebuild-equals-live test pins this. New event types go in
  `docs/MODEL.md` with their payload and projection.
- **Fence order is a contract.** `validateFence` reports the most specific
  failure first; do not reorder it without a changelog entry.

## Dev loop

```sh
npm install
npm run build      # tsup → dist/
npm test           # vitest (builds first)
npm run lint       # eslint flat config
npm run typecheck  # tsc --noEmit
```

Run the server against a scratch data dir:

```sh
node dist/cli.js serve --data-dir /tmp/sea-dev --actor dev --role operator
```

`kronicle-lite` is a `file:../kronicle-lite` dependency during development;
check out both repositories side by side and build kronicle-lite first.

## Pull requests

- One logical change per PR. Tests for anything that touches fencing,
  transactions, the lifecycle table, the cycle check or rebuild.
- If you touch concurrency, say in the PR body which interleaving could go
  wrong before your change and why it cannot after.
- Keep dependencies minimal. New runtime dependencies need a reason.

## Reporting security issues

Please do not open a public issue for a suspected fence bypass or chain
integrity problem. Email the maintainer (see `package.json`) with details and
a reproduction; you will get a response within a few days.
