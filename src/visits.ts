const VISITOR_COOKIE = "ai_signal_visitor";
const VISITOR_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const RETENTION_DAYS = 30;

export type Visit = {
  id: string;
  visitorKey: string;
  visitDay: string;
  path: string;
  visitedAt: string;
  country: string | null;
  region: string | null;
  city: string | null;
};

export type VisitLocation = {
  country?: string | null;
  region?: string | null;
  city?: string | null;
};

export type VisitLocationSummary = {
  country: string;
  region: string;
  uniqueVisitors: number;
};

export type VisitSummary = {
  visits: Visit[];
  total: number;
  totalEntries: number;
  uniqueVisitors: number;
  todayEntries: number;
  todayUniqueVisitors: number;
  byLocation: VisitLocationSummary[];
};

type VisitRow = {
  id: string;
  visitor_key: string;
  visit_day: string;
  path: string;
  visited_at: string;
  country: string | null;
  region: string | null;
  city: string | null;
};

type CloudflareRequestLocation = {
  country?: unknown;
  region?: unknown;
  city?: unknown;
};

function cleanLocation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}

export function requestLocation(request: Request): VisitLocation {
  const cf = (request as Request & { cf?: CloudflareRequestLocation }).cf;
  return {
    country: cleanLocation(cf?.country),
    region: cleanLocation(cf?.region),
    city: cleanLocation(cf?.city)
  };
}

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

export async function recordVisit(db: D1Database, visit: { visitorKey: string; path: string; location?: VisitLocation; visitedAt?: string }): Promise<void> {
  const visitedAt = visit.visitedAt ?? new Date().toISOString();
  const visitDay = visitedAt.slice(0, 10);
  const cutoff = retentionCutoff();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO visits (id, visitor_key, visit_day, path, visited_at, country, region, city) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(crypto.randomUUID(), visit.visitorKey, visitDay, visit.path, visitedAt, visit.location?.country ?? null, visit.location?.region ?? null, visit.location?.city ?? null),
    db.prepare("DELETE FROM visits WHERE visited_at < ?1").bind(cutoff)
  ]);
}

export async function listVisits(db: D1Database, limit = 50): Promise<VisitSummary> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  await db.prepare("DELETE FROM visits WHERE visited_at < ?1").bind(retentionCutoff()).run();
  const rows = await db.prepare("SELECT id, visitor_key, visit_day, path, visited_at, country, region, city FROM visits ORDER BY visited_at DESC LIMIT ?1")
    .bind(safeLimit)
    .all<VisitRow>();
  const today = new Date().toISOString().slice(0, 10);
  const count = await db.prepare("SELECT COUNT(*) AS total FROM visits").first<{ total: number }>();
  const unique = await db.prepare("SELECT COUNT(DISTINCT visitor_key) AS total FROM visits").first<{ total: number }>();
  const todayCount = await db.prepare("SELECT COUNT(*) AS total FROM visits WHERE visit_day = ?1").bind(today).first<{ total: number }>();
  const todayUnique = await db.prepare("SELECT COUNT(DISTINCT visitor_key) AS total FROM visits WHERE visit_day = ?1").bind(today).first<{ total: number }>();
  const locations = await db.prepare("SELECT COALESCE(NULLIF(country, ''), 'Unknown') AS country, COALESCE(NULLIF(region, ''), 'Unknown') AS region, COUNT(DISTINCT visitor_key) AS unique_visitors FROM visits GROUP BY COALESCE(NULLIF(country, ''), 'Unknown'), COALESCE(NULLIF(region, ''), 'Unknown') ORDER BY unique_visitors DESC, country ASC, region ASC LIMIT 30").all<{ country: string; region: string; unique_visitors: number }>();
  const totalEntries = Number(count?.total ?? 0);
  return {
    visits: rows.results.map((row) => ({
      id: row.id,
      visitorKey: row.visitor_key,
      visitDay: row.visit_day,
      path: row.path,
      visitedAt: row.visited_at,
      country: row.country,
      region: row.region,
      city: row.city
    })),
    total: totalEntries,
    totalEntries,
    uniqueVisitors: Number(unique?.total ?? 0),
    todayEntries: Number(todayCount?.total ?? 0),
    todayUniqueVisitors: Number(todayUnique?.total ?? 0),
    byLocation: locations.results.map((row) => ({ country: row.country, region: row.region, uniqueVisitors: Number(row.unique_visitors ?? 0) }))
  };
}

function retentionCutoff(): string {
  return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
