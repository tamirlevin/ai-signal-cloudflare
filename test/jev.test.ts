import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE } from "../src/contracts";
import { buildJevQuestions, jevShadowEnabled, scoreJevShadow } from "../src/jev";

const items = [
  { url: "https://example.com/agents", title: "Agent runtime launches", summary: "A practical agent platform with scoped credentials." },
  { url: "https://example.com/gossip", title: "Unrelated celebrity news", summary: "Nothing to do with AI tooling." }
];

function jevResponse(answers: Record<string, unknown>) {
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 10 } }));
}

function fakeFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jevResponse({
    interest: { type: "choice", choice: "New systems", confidence: 0.82, probabilities: { "New systems": 0.82 } },
    novel: { type: "noul", noul: 0.71 },
    substantive: { type: "noul", noul: 0.93 }
  }));
}

describe("jev shadow scoring", () => {
  it("is enabled only by the explicit flag", () => {
    expect(jevShadowEnabled({ JEV_SHADOW_ENABLED: "true" } as Env)).toBe(true);
    expect(jevShadowEnabled({ JEV_SHADOW_ENABLED: "false" } as Env)).toBe(false);
    expect(jevShadowEnabled({} as Env)).toBe(false);
  });

  it("builds an interest choice with watching topics and a none option", () => {
    const questions = buildJevQuestions(DEFAULT_PROFILE, ["Prior story one", "Prior story two"]);
    expect(questions.interest?.type).toBe("choice");
    const options = Object.keys(questions.interest?.criteria as Record<string, string>);
    expect(options).toContain("Codex & agent craft");
    expect(options).toContain("Watching: Agent permission design");
    expect(options).toContain("none");
    expect(questions.novel?.type).toBe("noul");
    expect(questions.substantive?.type).toBe("noul");
  });

  it("scores every item and parses typed answers", async () => {
    const fetchImpl = fakeFetch();
    const scores = await scoreJevShadow("key", DEFAULT_PROFILE, items, ["Prior story"], fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(scores.get("https://example.com/agents")).toEqual({ interest: "New systems", interestConfidence: 0.82, novel: 0.71, substantive: 0.93 });
    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    const body = JSON.parse(String((firstCall![1] as RequestInit).body));
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions)).toEqual(["interest", "novel", "substantive"]);
  });

  it("fails open per item and skips entirely without a key", async () => {
    const failing = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("typesafe")) throw new Error("boom");
      return new Response("{}");
    });
    expect(await scoreJevShadow("key", DEFAULT_PROFILE, [], [], failing as unknown as typeof fetch)).toEqual(new Map());
    const noKey = vi.fn(async () => jevResponse({}));
    expect(await scoreJevShadow("", DEFAULT_PROFILE, items, [], noKey as unknown as typeof fetch)).toEqual(new Map());
    expect(noKey).not.toHaveBeenCalled();
    const flaky = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String((init?.body as string) ?? "").includes("gossip")) return new Response("unavailable", { status: 500 });
      return jevResponse({ interest: { type: "choice", choice: "Agents in practice", confidence: 0.6 }, novel: { type: "noul", noul: 0.5 }, substantive: { type: "noul", noul: 0.5 } });
    });
    const scores = await scoreJevShadow("key", DEFAULT_PROFILE, items, [], flaky as unknown as typeof fetch);
    expect(scores.has("https://example.com/agents")).toBe(true);
    expect(scores.has("https://example.com/gossip")).toBe(false);
  });
});
