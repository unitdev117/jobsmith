import type { JobBoard } from "../../src/server/jobStore.ts";

// Full JobBoard whose read defaults are harmless and whose mutations fail
// loudly; tests pass only the overrides their route under test touches.
export function unusedJobBoard(overrides: Partial<JobBoard> = {}): JobBoard {
  return {
    listPage: async () => ({ jobs: [], nextCursor: null }),
    countAll: async () => 0,
    create: async () => {
      throw new Error("not used");
    },
    update: async () => {
      throw new Error("not used");
    },
    cancel: async () => {
      throw new Error("not used");
    },
    claim: async () => {
      throw new Error("not used");
    },
    transition: async () => {
      throw new Error("not used");
    },
    setProgress: async () => {
      throw new Error("not used");
    },
    addNote: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}
