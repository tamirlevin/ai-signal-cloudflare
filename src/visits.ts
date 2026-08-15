const VISITOR_COOKIE = "ai_signal_visitor";
const VISITOR_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const RETENTION_DAYS = 30;

export type Visit = {
  id: string;
  visitorKey: string;
  visitDay: string;
  path: string;
  visitedAt: string;
};

type VisitRow = {
  id: string;
  visitor_key: string;
  visit_day: string;
  path: string;
  visited_at: string;
};

function cookieValue(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== VISITOR_COOKIE) continue;
    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      return /^[A-Za-z0-9_-]{20,80}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function visitorIdentity(request: Request): { key: string; setCookie: boolean } {
  const existing = cookieValue(request);
  if (existing) return { key: existing, setCookie: false };
  return { key: crypto.randomUUID(), setCookie: true };
}

export function visitorSetCookie(key: string): string {
  return `${VISITOR_COOKIE}=${encodeURIComponent(key)}; Max-Age=${VISITOR_COOKIE_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export async function recordVisit(db: D1Database, visit: { visitorKey: string; path: string; visitedAt?: string }): Promise<void> {
  const visitedAt = visit.visitedAt ?? new Date().toISOString();
  const visitDay = visitedAt.slice(0, 10);
  const cutoff = retentionCutoff();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO visits (id, visitor_key, visit_day, path, visited_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(crypto.randomUUID(), visit.visitorKey, visitDay, visit.path, visitedAt),
    db.prepare("DELETE FROM visits WHERE visited_at < ?1").bind(cutoff)
  ]);
}

export async function listVisits(db: D1Database, limit = 50): Promise<{ visits: Visit[]; total: number }> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  await db.prepare("DELETE FROM visits WHERE visited_at < ?1").bind(retentionCutoff()).run();
  const rows = await db.prepare("SELECT id, visitor_key, visit_day, path, visited_at FROM visits ORDER BY visited_at DESC LIMIT ?1")
    .bind(safeLimit)
    .all<VisitRow>();
  const count = await db.prepare("SELECT COUNT(*) AS total FROM visits").first<{ total: number }>();
  return {
    visits: rows.results.map((row) => ({
      id: row.id,
      visitorKey: row.visitor_key,
      visitDay: row.visit_day,
      path: row.path,
      visitedAt: row.visited_at
    })),
    total: Number(count?.total ?? 0)
  };
}

function retentionCutoff(): string {
  return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
