/**
 * Thin client for TypeSafe's Jev structured-evaluation model on Workers AI.
 * Phase 1 is schema discovery only: one call shape in, raw answers out.
 * The shadow-judge comparison (Phase 3) builds on this module.
 */
export const JEV_MODEL = "typesafe/jev";

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
