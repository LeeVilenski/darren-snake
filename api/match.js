// Darren Snake versus mode: 1-on-1 matches joined with a 4-letter room code.
// Each player runs their own board. The server only keeps each player's
// score, lives and level, and decides the winner (last player standing).
//
// POST /api/match with a JSON body:
//   { action: 'create', name }                      -> { code, token, player }
//   { action: 'join', code, name }                  -> { code, token, player, ...state }
//   { action: 'sync', code, token, score, lives, level, cleared? } -> state
//   { action: 'leave', code, token }                -> { ok }
// "state" is { status, winner, endReason, startInMs, player, opp: { name, score, lives, level } }.
import { neon } from '@neondatabase/serverless';
import { randomBytes, randomInt } from 'node:crypto';

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = DB_URL ? neon(DB_URL) : null;

const START_LIVES = 3;      // keep in step with the table default below
const IDLE_LIMIT_S = 20;      // a player who stops syncing this long loses
const WAITING_LIMIT = '15 minutes';
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

let tablesReady;
function ensureTables() {
  tablesReady ??= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS matches (
      code text PRIMARY KEY,
      status text NOT NULL DEFAULT 'waiting',
      winner smallint,
      end_reason text,
      start_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS match_players (
      code text NOT NULL REFERENCES matches(code) ON DELETE CASCADE,
      slot smallint NOT NULL,
      token text NOT NULL,
      name text NOT NULL,
      score integer NOT NULL DEFAULT 0,
      lives smallint NOT NULL DEFAULT 3,
      level smallint NOT NULL DEFAULT 1,
      seen timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (code, slot)
    )`;
  })().catch(err => { tablesReady = undefined; throw err; });
  return tablesReady;
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const cleanName = raw => {
  const name = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N} ._'!-]{2,16}$/u.test(name) ? name : null;
};
const cleanCode = raw => String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
const newCode = () => Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');

// Ends the match once, whoever gets there first.
async function finish(code, winner, reason) {
  await sql`UPDATE matches SET status = 'over', winner = ${winner}, end_reason = ${reason}
            WHERE code = ${code} AND winner IS NULL`;
}

// Builds what a player needs to know, and settles the winner when the match is decided.
async function matchState(code, slot, cleared = false) {
  const [match] = await sql`SELECT status, winner, end_reason,
      GREATEST(0, EXTRACT(EPOCH FROM (start_at - now())) * 1000)::int AS start_in_ms
    FROM matches WHERE code = ${code}`;
  if (!match) return null;
  const players = await sql`SELECT slot, name, score, lives, level,
      EXTRACT(EPOCH FROM (now() - seen))::float AS idle_s
    FROM match_players WHERE code = ${code}`;
  const me = players.find(p => p.slot === slot);
  const opp = players.find(p => p.slot !== slot);

  if (match.status === 'playing' && match.winner == null && me && opp) {
    const oppSlot = opp.slot;
    let result = null;
    if (me.lives <= 0) result = [oppSlot, 'lives'];
    else if (opp.lives <= 0) result = [slot, 'lives'];
    else if (cleared) result = [slot, 'cleared'];
    // Only count the opponent as gone once the match has properly started.
    else if (match.start_in_ms === 0 && opp.idle_s > IDLE_LIMIT_S) result = [slot, 'timeout'];
    if (result) {
      await finish(code, ...result);
      return matchState(code, slot);
    }
  }
  return {
    status: match.status,
    winner: match.winner,
    endReason: match.end_reason,
    startInMs: match.start_in_ms ?? 0,
    player: slot,
    opp: opp ? { name: opp.name, score: opp.score, lives: opp.lives, level: opp.level } : null,
  };
}

async function create(body) {
  const name = cleanName(body.name);
  if (!name) return [400, { error: 'Name must be 2–16 letters or numbers.' }];
  await sql`DELETE FROM matches WHERE created_at < now() - interval '1 day'`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    const made = await sql`INSERT INTO matches (code) VALUES (${code}) ON CONFLICT DO NOTHING RETURNING code`;
    if (!made.length) continue;
    const token = randomBytes(16).toString('hex');
    await sql`INSERT INTO match_players (code, slot, token, name) VALUES (${code}, 1, ${token}, ${name})`;
    return [201, { code, token, player: 1 }];
  }
  return [503, { error: 'Could not create a match. Please try again.' }];
}

async function join(body) {
  const name = cleanName(body.name);
  const code = cleanCode(body.code);
  if (!name) return [400, { error: 'Name must be 2–16 letters or numbers.' }];
  if (code.length !== 4) return [400, { error: 'Match codes are 4 letters.' }];
  const [match] = await sql`SELECT status, created_at > now() - ${WAITING_LIMIT}::interval AS fresh
    FROM matches WHERE code = ${code}`;
  if (!match) return [404, { error: 'No match with that code.' }];
  if (match.status !== 'waiting') return [409, { error: 'That match has already started.' }];
  if (!match.fresh) return [410, { error: 'That match code has expired.' }];
  const token = randomBytes(16).toString('hex');
  const joined = await sql`INSERT INTO match_players (code, slot, token, name)
    VALUES (${code}, 2, ${token}, ${name}) ON CONFLICT DO NOTHING RETURNING slot`;
  if (!joined.length) return [409, { error: 'That match is already full.' }];
  // A short delay lets the host's next check-in arrive, so both boards start together.
  await sql`UPDATE matches SET status = 'playing', start_at = now() + interval '3.5 seconds'
            WHERE code = ${code} AND status = 'waiting'`;
  await sql`UPDATE match_players SET seen = now() + interval '3.5 seconds' WHERE code = ${code}`;
  return [200, { code, token, ...(await matchState(code, 2)) }];
}

async function sync(body) {
  const code = cleanCode(body.code);
  const token = String(body.token ?? '');
  const { score, lives, level } = body;
  if (!isInt(score, 0, 2_000_000) || !isInt(lives, 0, START_LIVES) || !isInt(level, 1, 200))
    return [400, { error: 'Invalid update.' }];
  // Scores and levels only go up and lives only go down, so a late or
  // repeated request can never undo progress.
  const [me] = await sql`UPDATE match_players SET
      score = GREATEST(score, ${score}), lives = LEAST(lives, ${lives}),
      level = GREATEST(level, ${level}), seen = GREATEST(seen, now())
    WHERE code = ${code} AND token = ${token}
      AND EXISTS (SELECT 1 FROM matches m WHERE m.code = ${code} AND m.status <> 'over')
    RETURNING slot`;
  if (me) return [200, await matchState(code, me.slot, body.cleared === true)];
  // The match may already be over; still report the result.
  const [player] = await sql`SELECT slot FROM match_players WHERE code = ${code} AND token = ${token}`;
  if (!player) return [404, { error: 'Match not found.' }];
  return [200, await matchState(code, player.slot)];
}

async function leave(body) {
  const code = cleanCode(body.code);
  const token = String(body.token ?? '');
  const [player] = await sql`SELECT p.slot, m.status FROM match_players p JOIN matches m USING (code)
    WHERE p.code = ${code} AND p.token = ${token}`;
  if (!player) return [200, { ok: true }];
  if (player.status === 'waiting') await sql`DELETE FROM matches WHERE code = ${code}`;
  else if (player.status === 'playing') {
    await sql`UPDATE match_players SET lives = 0 WHERE code = ${code} AND slot = ${player.slot}`;
    await finish(code, player.slot === 1 ? 2 : 1, 'left');
  }
  return [200, { ok: true }];
}

const actions = { create, join, sync, leave };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!sql) return res.status(500).json({ error: 'Versus database is not configured.' });
  let body = req.body;
  // sendBeacon (used when a player closes the page) posts plain text.
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const action = actions[body?.action];
  if (!action) return res.status(400).json({ error: 'Unknown action.' });
  try {
    await ensureTables();
    const [status, data] = await action(body);
    return res.status(status).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Versus is unavailable right now.' });
  }
}
