# DuelLoop SDK distribution

Production uses the unmodified `duelloop-0.2.2.tgz` from public source commit
[`422e24832919a3d72a2936272365e4c827178ec2`](https://github.com/hewenyu/DuelLoop/commit/422e24832919a3d72a2936272365e4c827178ec2),
reviewed in [SDK PR #1](https://github.com/hewenyu/DuelLoop/pull/1).
It is a production dependency, includes the upstream MIT license and third-party notices,
and contains the SDK live cancellation, execution receipt and research trigger contracts.

SHA-256: `d1584c90b2fb81d976a41de9456c5aa27df90e8dec9c1ef2e52b5955f1086400`.
Size: 173,239 bytes. SDK verification: 239 tests and the independent package installation gate.
The public-source byte comparison is repeated by the application verification command below.

## Historical archive

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
historical dependency retained to reproduce the PR #6 shadow experiment. New production
and replay use 0.2.2; old measured evidence retains its original version and hash.

The npm lockfile pins SHA-512 integrity. Rebuild and compare from the public source:

```sh
node scripts/verify-duelloop-package.mjs
# Reproduce the earlier audit package instead:
node scripts/verify-duelloop-package.mjs 0.2.1
```

This command clones the pinned commit into a temporary directory, installs the
upstream locked build dependencies, runs its `prepack` build, and compares the
archive byte-for-byte. It does not modify either project or call a model.
