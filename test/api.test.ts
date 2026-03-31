import { describe, it, expect } from "vitest";

/**
 * API composition tests.
 *
 * The phase functions (distill, elicit, generate, cover, weed) call real agents
 * so they can't be unit tested without API keys. These tests verify the module
 * structure, type exports, and compositional contracts.
 */

// Verify all phases and orchestrators are exported
describe("api exports", () => {
  it("exports all five phases", async () => {
    const api = await import("../src/api.js");
    expect(typeof api.distill).toBe("function");
    expect(typeof api.elicit).toBe("function");
    expect(typeof api.generate).toBe("function");
    expect(typeof api.cover).toBe("function");
    expect(typeof api.weed).toBe("function");
  });

  it("exports all three orchestrators", async () => {
    const api = await import("../src/api.js");
    expect(typeof api.takeover).toBe("function");
    expect(typeof api.change).toBe("function");
    expect(typeof api.sync).toBe("function");
  });

  it("re-exports all domain types", async () => {
    // This test verifies that the type re-exports compile.
    // If any type is missing from the re-export, TypeScript would
    // catch it at compile time, but this confirms the module loads.
    const api = await import("../src/api.js");
    expect(api).toBeDefined();
  });
});

// Verify the new agent entry points exist
describe("agent entry points", () => {
  it("exports runDistiller from archaeologist module", async () => {
    const { runDistiller } = await import("../src/agents/archaeologist.js");
    expect(typeof runDistiller).toBe("function");
  });

  it("exports runWeeder from archaeologist module", async () => {
    const { runWeeder } = await import("../src/agents/archaeologist.js");
    expect(typeof runWeeder).toBe("function");
  });
});
