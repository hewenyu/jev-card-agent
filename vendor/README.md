# DuelLoop SDK distribution

`duelloop-0.2.1.tgz` is the unmodified `npm pack` output of
[hewenyu/DuelLoop](https://github.com/hewenyu/DuelLoop/tree/cba13bb69453f7ea2cd7a79db9d3fbe9859eabc4),
commit `cba13bb69453f7ea2cd7a79db9d3fbe9859eabc4`, tag `v0.2.1`.
The upstream MIT license and third-party notices are inside the archive.

SHA-256: `4a38c6bec56864a792b5e1279fa464f382c26f9342e870aa4fa785ac86d83adb`.
The package is 165,230 bytes; its public-source reproduction was verified for
the PR #6 audit update. The older 0.2.0 real-model evidence retains its original
version and package hash; it is not a measurement of this SDK update.

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
