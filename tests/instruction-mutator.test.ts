import { describe, it, expect } from "vitest";
import {
  mutateSpecific,
  mutateDecompose,
} from "../src/core/instruction-mutator.js";

describe("mutateSpecific", () => {
  it("returns specific mutation when DOM context matches keywords", () => {
    const dom = `<button#login-btn .primary> "Sign In"
<a.nav-link> "About Us"
<input type="email" placeholder="Enter email">`;

    const result = mutateSpecific("Click the sign in button", dom);
    expect(result.type).toBe("specific");
    expect(result.instructions[0]).toContain("Sign In");
  });

  it("falls back to rephrase when no DOM match", () => {
    const dom = `<div> "Hello World"`;
    const result = mutateSpecific("Toggle the quantum flux capacitor", dom);
    expect(result.type).toBe("rephrase");
  });

  it("handles empty DOM context", () => {
    const result = mutateSpecific("Click login", "");
    expect(result.type).toBe("rephrase");
    expect(result.instructions.length).toBe(1);
  });
});

describe("mutateDecompose", () => {
  it("decomposes 'X, then Y' pattern", () => {
    const result = mutateDecompose("Click the dropdown, then select English");
    expect(result.type).toBe("decompose");
    expect(result.instructions).toHaveLength(2);
    expect(result.instructions[0]).toContain("dropdown");
    expect(result.instructions[1]).toContain("English");
  });

  it("decomposes 'click X and click Y' pattern", () => {
    const result = mutateDecompose("Click the menu and click logout");
    expect(result.type).toBe("decompose");
    expect(result.instructions).toHaveLength(2);
  });

  it("decomposes 'fill X with Y' pattern", () => {
    const result = mutateDecompose("Fill in the email field with test@example.com");
    expect(result.type).toBe("decompose");
    expect(result.instructions).toHaveLength(2);
    expect(result.instructions[0]).toContain("email");
    expect(result.instructions[1]).toContain("test@example.com");
  });

  it("decomposes 'select X from Y dropdown' pattern", () => {
    const result = mutateDecompose("Select Japanese from the language dropdown");
    expect(result.type).toBe("decompose");
    expect(result.instructions).toHaveLength(2);
    expect(result.instructions[0]).toContain("language");
    expect(result.instructions[1]).toContain("Japanese");
  });

  it("falls back to rephrase for simple instructions", () => {
    const result = mutateDecompose("Click the login button");
    expect(result.type).toBe("rephrase");
    expect(result.instructions).toHaveLength(1);
  });

  it("handles empty string without crashing", () => {
    const result = mutateDecompose("");
    expect(result.instructions.length).toBeGreaterThan(0);
  });
});
