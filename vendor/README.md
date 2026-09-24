# DuelLoop SDK distribution

`duelloop-0.2.0.tgz` is the unmodified `npm pack` output of
[hewenyu/DuelLoop](https://github.com/hewenyu/DuelLoop/tree/4bd7e9bb0e0322fe1d4297beeff3349918b175c9),
commit `4bd7e9bb0e0322fe1d4297beeff3349918b175c9`, tag `v0.2.0`.
The upstream MIT license and third-party notices are inside the archive.

Upstream has not published to npm, does not commit `dist/`, and has no Git-install
`prepare` hook. This archive makes clean checkouts reproducible. It is a
development dependency used by the independent shadow experiment. The production
server does not load the SDK or its pi dependencies.

The npm lockfile pins SHA-512 integrity. Rebuild and compare from the public source:

```sh
node scripts/verify-duelloop-package.mjs
```

This command clones the pinned commit into a temporary directory, installs the
upstream locked build dependencies, runs its `prepack` build, and compares the
archive byte-for-byte. It does not modify either project or call a model.
