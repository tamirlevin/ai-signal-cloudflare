import { describe, expect, it } from "vitest";
import { errorCode } from "../src/repository";
import { isModelJsonInvalid, isModelTimeout } from "../src/generation";

describe("generation error classification", () => {
  it("classifies Workers AI request timeouts explicitly", () => {
    expect(errorCode(new Error("3046: Request timeout"))).toBe("MODEL_TIMEOUT");
    expect(errorCode(new Error("3007"))).toBe("MODEL_TIMEOUT");
    expect(isModelTimeout(new Error("3046: Request timeout"))).toBe(true);
  });

  it("classifies malformed model JSON explicitly", () => {
    expect(isModelJsonInvalid(new SyntaxError("Expected double-quoted property name"))).toBe(true);
    expect(isModelJsonInvalid(new Error("Model did not return a JSON edition"))).toBe(true);
    expect(isModelJsonInvalid(new Error("schema validation failed"))).toBe(false);
  });
});
