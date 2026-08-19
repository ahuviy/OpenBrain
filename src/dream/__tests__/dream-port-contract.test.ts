/**
 * The in-memory port must satisfy the same contract as the real one.
 */

import { describe } from "vitest";

import dreamPortContractTests from "../../integration-suites/dream-port-contract.suite.js";
import { fakeDreamStore, type FakeDreamStore } from "./fake-port.js";

describe("fake dream port", () => {
  let store: FakeDreamStore;

  dreamPortContractTests({
    setup: async () => {
      store = fakeDreamStore();
      store.reset();
    },
    port: () => store.port,
    seed: (thought) => store.seed(thought),
    read: (id) => store.read(id),
    cleanup: async () => {},
  });
});
