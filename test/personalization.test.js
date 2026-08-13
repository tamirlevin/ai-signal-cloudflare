import { describe, expect, it } from "vitest";
import { baseProfileForEdition } from "../public/personalization.js";

describe("reader profile selection", () => {
  const shared = { version: 5, storyBudget: 14 };
  const generated = { version: 2, storyBudget: 7 };

  it("uses the active global profile for the latest reader", () => {
    expect(baseProfileForEdition(shared, generated, false)).toEqual(shared);
  });

  it("retains the generated profile for a historical edition", () => {
    expect(baseProfileForEdition(shared, generated, true)).toEqual(generated);
  });
});
