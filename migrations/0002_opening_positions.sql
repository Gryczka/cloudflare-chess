-- P5-C: Opening explorer positions table.
-- Tracks which moves were played from each position across all archived games.
-- fen_key is the normalized FEN (piece positions + side to move only, no clocks).
-- continuation is the UCI move played from this position.
-- Populated by the queue consumer after each game is archived.

CREATE TABLE IF NOT EXISTS positions (
	fen_key      TEXT NOT NULL,
	continuation TEXT NOT NULL,
	count        INTEGER NOT NULL DEFAULT 0,
	white_wins   INTEGER NOT NULL DEFAULT 0,
	draws        INTEGER NOT NULL DEFAULT 0,
	black_wins   INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (fen_key, continuation)
);

CREATE INDEX IF NOT EXISTS positions_fen_idx
	ON positions (fen_key, count DESC);
