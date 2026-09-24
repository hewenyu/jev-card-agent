import { DuelLoopError, type DuelLoop, type DuelLoopStore } from 'duelloop';

/** Call only from the authenticated host controller, never from a provider tool. */
export function createReleaseControls(runtime: DuelLoop, store: DuelLoopStore, scopeId: string) {
  return {
    status: () => store.scopeStatus(scopeId, runtime.dependencies),
    pause(paused: boolean) {
      store.pauseActivation(scopeId, paused);
    },
    async approve(releaseDigest: string) {
      const release = store.release(releaseDigest);
      if (release.scopeId !== scopeId || release.source !== 'research' || !release.validationDigest)
        throw new DuelLoopError(
          'VALIDATION_REJECTED',
          'Only a validated research release in this scope may be approved',
        );
      // Runtime performs dependency/eligibility/boundary checks; approval cannot bypass them.
      await runtime.activate(releaseDigest, true);
    },
    async rollback(releaseDigest: string) {
      await runtime.rollback(scopeId, releaseDigest);
    },
  };
}
