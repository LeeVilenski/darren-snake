// Darren Snake online leaderboard.
// GET  /api/scores  -> top 10 players (each player's best score)
// POST /api/scores  -> submit a score: { name, score, level, mayo, durationMs }
import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = DB_URL ? neon(DB_URL) : null;

let tableReady;
function ensureTable() {
  tableReady ??= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS scores (
      id serial PRIMARY KEY,
      name text NOT NULL,
      score integer NOT NULL,
      level integer NOT NULL,
      mayo integer NOT NULL,
      duration_ms integer NOT NULL,
      ip_hash text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS scores_name_idx ON scores (lower(name), score DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS scores_ip_idx ON scores (ip_hash, created_at DESC)`;
  })().catch(err => { tableReady = undefined; throw err; });
  return tableReady;
}

// One row per player (their best), highest first.
const topScores = () => sql`
  SELECT name, score, level FROM (
    SELECT DISTINCT ON (lower(name)) name, score, level, created_at
    FROM scores ORDER BY lower(name), score DESC, created_at ASC
  ) best
  ORDER BY score DESC, created_at ASC
  LIMIT 10`;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Checks the submission is consistent with how the game awards points:
// mayo = 100, tooth = 200, RAM Gigaboo = 2000, and level L needs (L-1)(L+2) jars.
// The 23H2 bonus doubles mayo (200) and teeth (400) while it runs; RAM is never doubled.
// This stops casual tampering, not a determined cheat (the game runs in the browser).
function validate(body) {
  const name = String(body?.name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const { score, level, mayo, durationMs } = body ?? {};
  if (!/^[\p{L}\p{N} ._'!-]{2,16}$/u.test(name)) return { error: 'Name must be 2–16 letters or numbers.' };
  if (!isInt(score, 100, 2_000_000) || !isInt(level, 1, 200) || !isInt(mayo, 0, 5000) || !isInt(durationMs, 0, 86_400_000))
    return { error: 'Invalid score.' };
  // Teeth (Level 2+) appear every few jars; RAM rounds (Level 3+) need well over 10s each.
  // `bonus` is everything above 100 per jar: doubled jars, teeth and RAM rounds.
  const bonus = score - mayo * 100;
  const maxTeeth = level >= 2 ? mayo : 0;
  const maxRam = level >= 3 ? Math.floor(durationMs / 10_000) + 1 : 0;
  const ok = score % 100 === 0 && bonus >= 0 &&
    bonus <= mayo * 100 + maxTeeth * 400 + maxRam * 2000 &&
    mayo >= (level - 1) * (level + 2) && durationMs >= mayo * 100;
  if (!ok) return { error: 'That score does not add up.' };
  return { name, score, level, mayo, durationMs };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!sql) return res.status(500).json({ error: 'Leaderboard database is not configured.' });

  try {
    await ensureTable();

    if (req.method === 'GET') {
      return res.status(200).json({ scores: await topScores() });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      const entry = validate(body);
      if (entry.error) return res.status(400).json({ error: entry.error });

      // Store a salted hash rather than the raw IP; used only for rate limiting.
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ipHash = createHash('sha256').update(ip + (process.env.LEADERBOARD_SALT || 'darren-snake')).digest('hex').slice(0, 32);
      const recent = await sql`SELECT 1 FROM scores WHERE ip_hash = ${ipHash} AND created_at > now() - interval '15 seconds' LIMIT 1`;
      if (recent.length) return res.status(429).json({ error: 'Slow down — try again in a few seconds.' });

      await sql`INSERT INTO scores (name, score, level, mayo, duration_ms, ip_hash)
                VALUES (${entry.name}, ${entry.score}, ${entry.level}, ${entry.mayo}, ${entry.durationMs}, ${ipHash})`;

      const [{ best }] = await sql`SELECT max(score)::int AS best FROM scores WHERE lower(name) = lower(${entry.name})`;
      const [{ rank }] = await sql`
        SELECT count(*)::int + 1 AS rank FROM (
          SELECT lower(name) AS n, max(score) AS s FROM scores GROUP BY lower(name)
        ) b WHERE b.s > ${best}`;
      return res.status(201).json({ rank, best, scores: await topScores() });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Leaderboard is unavailable right now.' });
  }
}
