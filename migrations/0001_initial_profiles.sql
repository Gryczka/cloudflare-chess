-- P3-E: Initial D1 schema for profiles, ratings, rating_history, rated_games.
-- Designed for Phase 3 (de-singleton) + Phase 3-F (per-time-control ratings).
-- time_control column is included from day one so no future migration is needed.

CREATE TABLE IF NOT EXISTS profiles (
	player_id      TEXT PRIMARY KEY,
	username       TEXT NOT NULL,
	secret_hash    TEXT,
	rating         INTEGER NOT NULL DEFAULT 1200,
	peak_rating    INTEGER NOT NULL DEFAULT 1200,
	games          INTEGER NOT NULL DEFAULT 0,
	wins           INTEGER NOT NULL DEFAULT 0,
	losses         INTEGER NOT NULL DEFAULT 0,
	draws          INTEGER NOT NULL DEFAULT 0,
	bot_games      INTEGER NOT NULL DEFAULT 0,
	bot_wins       INTEGER NOT NULL DEFAULT 0,
	bot_losses     INTEGER NOT NULL DEFAULT 0,
	bot_draws      INTEGER NOT NULL DEFAULT 0,
	created_at     INTEGER NOT NULL,
	updated_at     INTEGER NOT NULL
);

-- Per-time-control rating rows (P3-F).
-- One row per (player_id, time_control); time_control is one of 'bullet','blitz','rapid'.
CREATE TABLE IF NOT EXISTS tc_ratings (
	player_id      TEXT NOT NULL,
	time_control   TEXT NOT NULL,
	rating         INTEGER NOT NULL DEFAULT 1200,
	peak_rating    INTEGER NOT NULL DEFAULT 1200,
	games          INTEGER NOT NULL DEFAULT 0,
	wins           INTEGER NOT NULL DEFAULT 0,
	losses         INTEGER NOT NULL DEFAULT 0,
	draws          INTEGER NOT NULL DEFAULT 0,
	updated_at     INTEGER NOT NULL,
	PRIMARY KEY (player_id, time_control)
);

CREATE TABLE IF NOT EXISTS rating_history (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	player_id      TEXT NOT NULL,
	match_id       TEXT NOT NULL,
	time_control   TEXT NOT NULL DEFAULT 'blitz',
	rating         INTEGER NOT NULL,
	delta          INTEGER NOT NULL,
	opponent_id    TEXT NOT NULL,
	result         TEXT NOT NULL,
	is_bot         INTEGER NOT NULL DEFAULT 0,
	timestamp      INTEGER NOT NULL
);

-- Idempotency ledger — prevents double-applying the same game's result.
CREATE TABLE IF NOT EXISTS rated_games (
	match_id       TEXT PRIMARY KEY,
	white_id       TEXT NOT NULL,
	black_id       TEXT NOT NULL,
	white_delta    INTEGER NOT NULL,
	black_delta    INTEGER NOT NULL,
	time_control   TEXT NOT NULL DEFAULT 'blitz',
	recorded_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS profiles_rating_idx
	ON profiles (rating DESC, games DESC);

CREATE INDEX IF NOT EXISTS profiles_secret_idx
	ON profiles (secret_hash);

CREATE INDEX IF NOT EXISTS rating_history_player_idx
	ON rating_history (player_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS rating_history_match_idx
	ON rating_history (match_id);
