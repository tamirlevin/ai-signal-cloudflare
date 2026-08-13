import { describe, expect, it } from "vitest";
import { errorCode } from "../src/repository";
import { isModelTimeout } from "../src/generation";

describe("generation error classification", () => {
  it("classifies Workers AI request timeouts explicitly", () => {
    expect(errorCode(new Error("3046: Request timeout"))).toBe("MODEL_TIMEOUT");
    expect(errorCode(new Error("3007"))).toBe("MODEL_TIMEOUT");
    expect(isModelTimeout(new Error("3046: Request timeout"))).toBe(true);
  });
});
