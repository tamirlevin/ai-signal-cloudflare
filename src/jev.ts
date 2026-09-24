/**
 * Thin client for TypeSafe's Jev structured-evaluation model on Workers AI.
 * Phase 1 is schema discovery only: one call shape in, raw answers out.
 * The shadow-judge comparison (Phase 3) builds on this module.
 */
export const JEV_MODEL = "typesafe/jev";
export const JEV_DIRECT_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DIRECT_MODEL = "jev-latest";

export type JevQuestionType = "noul" | "choice" | "score";

export type JevQuestion = {
  type: JevQuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[];
};

export type JevProbeInput = {
  state: unknown;
  questions: Record<string, JevQuestion>;
};

type AiRunner = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };

export async function runJev(ai: AiRunner, input: JevProbeInput): Promise<unknown> {
  return ai.run(JEV_MODEL, input as Record<string, unknown>);
}

/**
 * Direct TypeSafe API call for the staging probe. The Workers AI route needs
 * separate Cloudflare-side third-party billing; the direct route uses the
 * TYPESAFE_API_KEY secret instead. Throws on non-2xx with status + body.
 */
export async function runJevDirect(input: JevProbeInput, apiKey: string): Promise<unknown> {
  const response = await fetch(JEV_DIRECT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: input.state, model: JEV_DIRECT_MODEL, questions: input.questions })
  });
  if (!response.ok) throw new Error(`Jev direct API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}
