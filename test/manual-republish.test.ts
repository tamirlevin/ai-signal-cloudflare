import { describe, expect, it } from "vitest";
import { claimManualRepublish, completeManualRepublish, melbourneCalendarDay, releaseManualRepublish } from "../src/repository";

function d1Result(changes: number) {
  return { success: true, meta: { changes }, results: [] };
}

function fakeDatabase(): D1Database {
  const claims = new Map<string, { claimId: string; status: "active" | "completed" }>();
  return {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        async run() {
          if (sql.startsWith("INSERT OR IGNORE")) {
            const [localDay, claimId] = this.values as [string, string];
            if (claims.has(localDay)) return d1Result(0);
            claims.set(localDay, { claimId, status: "active" });
            return d1Result(1);
          }
          if (sql.startsWith("UPDATE manual_republish_days")) {
            const [_, localDay, claimId] = this.values as [string, string, string];
            const claim = claims.get(localDay);
            if (!claim || claim.claimId !== claimId || claim.status !== "active") return d1Result(0);
            claim.status = "completed";
            return d1Result(1);
          }
          if (sql.startsWith("DELETE FROM manual_republish_days")) {
            const [localDay, claimId] = this.values as [string, string];
            const claim = claims.get(localDay);
            if (!claim || claim.claimId !== claimId || claim.status !== "active") return d1Result(0);
            claims.delete(localDay);
            return d1Result(1);
          }
          return d1Result(0);
        }
      };
      return statement as unknown as D1PreparedStatement;
    }
  } as unknown as D1Database;
}

describe("manual republish guard", () => {
  it("uses the Melbourne calendar day across midnight and the DST transition", () => {
    expect(melbourneCalendarDay(new Date("2026-08-28T13:59:59.000Z"))).toBe("2026-08-28");
    expect(melbourneCalendarDay(new Date("2026-08-28T14:00:00.000Z"))).toBe("2026-08-29");
    expect(melbourneCalendarDay(new Date("2026-10-03T15:59:59.000Z"))).toBe("2026-10-04");
    expect(melbourneCalendarDay(new Date("2026-10-03T16:00:00.000Z"))).toBe("2026-10-04");
  });

  it("allows one claim, releases failed attempts, and keeps completed claims used", async () => {
    const db = fakeDatabase();
    const first = await claimManualRepublish(db, "2026-08-29", new Date("2026-08-28T14:00:00.000Z"));
    expect(first).toMatchObject({ localDay: "2026-08-29" });
    await expect(claimManualRepublish(db, "2026-08-29")).resolves.toBeNull();

    await releaseManualRepublish(db, first!);
    const retry = await claimManualRepublish(db, "2026-08-29");
    expect(retry).toMatchObject({ localDay: "2026-08-29" });
    await completeManualRepublish(db, retry!);
    await expect(claimManualRepublish(db, "2026-08-29")).resolves.toBeNull();
  });
});
