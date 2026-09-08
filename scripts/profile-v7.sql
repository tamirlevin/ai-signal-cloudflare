-- Owner-authorized September 2026 profile transition, not an automatic migration.
-- Run as one batch through Wrangler D1 execute --command=<sql>; retains v6 for rollback.
-- Refuses to create v7 unless the active v6 has the expected three old weights.
INSERT INTO profiles (id, version, profile_json, is_active)
SELECT 'profile-v7-broader-discovery', 7,
  json_set(profile_json, '$.version', 7,
    '$.weights[' || (SELECT key FROM json_each(profile_json, '$.weights') WHERE json_extract(value, '$.id') = 'codex') || '].value', 3,
    '$.weights[' || (SELECT key FROM json_each(profile_json, '$.weights') WHERE json_extract(value, '$.id') = 'newSystems') || '].value', 3,
    '$.weights[' || (SELECT key FROM json_each(profile_json, '$.weights') WHERE json_extract(value, '$.id') = 'research') || '].value', 2), 0
FROM profiles
WHERE version = 6 AND is_active = 1
  AND (SELECT json_extract(value, '$.value') FROM json_each(profile_json, '$.weights') WHERE json_extract(value, '$.id') = 'codex') = 4
  AND (SELECT json_extract(value, '$.value') FROM json_each(profile_json, '$.weights') WHERE json_extract(value, '$.id') = 'newSystems') = 2
  AND (SELECT json_extract(value, '$.value') FROM json_each(profile_json, '$.weights') WHERE json_extract(value, '$.id') = 'research') = 1;
UPDATE profiles SET is_active = 0 WHERE version = 6 AND is_active = 1
  AND EXISTS (SELECT 1 FROM profiles WHERE id = 'profile-v7-broader-discovery' AND version = 7);
UPDATE profiles SET is_active = 1 WHERE id = 'profile-v7-broader-discovery' AND version = 7
  AND NOT EXISTS (SELECT 1 FROM profiles WHERE is_active = 1);
