import { DurableObject } from 'cloudflare:workers';
import { START_FEN, turnName, validateMove } from '../chess/engine';
import { botConfigFromId, chooseBotMove } from '../chess/bot';
import { searchWithScore } from '../chess/bot-search';
import { resolvePlayerId, safeUsername } from '../identity';
import { log } from '../log';
import {
	oppositeColor,
	resultForWinner,
	roleToTurn,
	type ChatMessage,
	type ClientMessage,
	type GameResult,
	type GameMode,
	type GameState,
	type MatchInit,
	type MoveRecord,
	type PlayerColor,
	type PresenceState,
	type Role,
	type ServerMessage,
} from '../messages';

type MetaRow = {
	matchId: string;
	mode: GameMode;
	whiteId: string;
	blackId: string;
	whiteName: string;
	blackName: string;
	whiteRating: number;
	blackRating: number;
	whiteRatingDelta: number;
	blackRatingDelta: number;
	whiteGames: number;
	blackGames: number;
	status: 'playing' | 'ended';
	fen: string;
	turn: 'w' | 'b';
	timeControlMs: number;
	whiteMs: number;
	blackMs: number;
	lastMoveAt: number;
	startedAt: number;
	endedAt: number | null;
	result: GameResult | null;
	endReason: string | null;
	drawOfferBy: PlayerColor | null;
	ratingRecorded: number;
	archiveWritten: number;
	ply: number;
};

type Session = {
	playerId: string;
	name: string;
	role: Role;
};

type MoveActor = {
	role: PlayerColor;
	source: 'human' | 'bot' | 'premove' | 'agent';
};

type MoveInput = {
	from: string;
	to: string;
	promotion?: 'q' | 'r' | 'b' | 'n';
	expectedPly?: number;
};

type ApplyMoveResult =
	| { ok: true; meta: MetaRow; ended: boolean }
	| { ok: false; code: 'stale_position' | 'not_your_turn' | 'illegal_move' | 'game_over'; message: string; meta: MetaRow };

/**
 * `ChessMatch` — one Durable Object instance per game.
 *
 * This class is the single source of truth for a game: board state, move
 * history, clocks, chat, and presence. It owns three SQLite tables in its own
 * isolated storage (`meta`, `moves`, `chat`) and coordinates everything over
 * WebSocket Hibernation — connections can hibernate between messages and the
 * DO itself can evict from memory between moves, with state always recovered
 * from `ctx.storage.sql`.
 *
 * Key responsibilities:
 * - Validate and apply moves (human, bot, and — in the future — agent/premove
 *   sources) through a single `applyMove()` path so legality, turn order, and
 *   clock enforcement are never duplicated or bypassed.
 * - Drive the game clock via the Alarm API (`alarm()`), including flag-fall
 *   detection and a pre-first-move abandonment timeout.
 * - On game end: best-effort fan-out to the `Matchmaker` DO (rating update),
 *   R2 (immutable archive), the `GameLobby` DO (deregister from spectator
 *   TV), and the analysis Queue (async AI coaching) — each wrapped so a
 *   downstream failure never blocks the authoritative game-over broadcast,
 *   with retries driven by the same alarm.
 */
export class ChessMatch extends DurableObject<Env> {
	private sessions = new Map<WebSocket, Session>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				matchId TEXT PRIMARY KEY,
				mode TEXT NOT NULL DEFAULT 'rated',
				whiteId TEXT NOT NULL,
				blackId TEXT NOT NULL,
				whiteName TEXT NOT NULL,
				blackName TEXT NOT NULL,
				whiteRating INTEGER NOT NULL DEFAULT 1200,
				blackRating INTEGER NOT NULL DEFAULT 1200,
				whiteRatingDelta INTEGER NOT NULL DEFAULT 0,
				blackRatingDelta INTEGER NOT NULL DEFAULT 0,
				whiteGames INTEGER NOT NULL DEFAULT 0,
				blackGames INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL,
				fen TEXT NOT NULL,
				turn TEXT NOT NULL,
				timeControlMs INTEGER NOT NULL,
				whiteMs INTEGER NOT NULL,
				blackMs INTEGER NOT NULL,
				lastMoveAt INTEGER NOT NULL,
				startedAt INTEGER NOT NULL,
				endedAt INTEGER,
				result TEXT,
				endReason TEXT,
				drawOfferBy TEXT,
				ratingRecorded INTEGER NOT NULL DEFAULT 0,
				ply INTEGER NOT NULL DEFAULT 0
			);
		`);
		this.ensureMetaColumn('mode', "TEXT NOT NULL DEFAULT 'rated'");
		this.ensureMetaColumn('whiteRating', 'INTEGER NOT NULL DEFAULT 1200');
		this.ensureMetaColumn('blackRating', 'INTEGER NOT NULL DEFAULT 1200');
		this.ensureMetaColumn('whiteRatingDelta', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureMetaColumn('blackRatingDelta', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureMetaColumn('whiteGames', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureMetaColumn('blackGames', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureMetaColumn('ratingRecorded', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureMetaColumn('archiveWritten', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureMetaColumn('ply', 'INTEGER NOT NULL DEFAULT 0');
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS moves (
				ply INTEGER PRIMARY KEY,
				san TEXT NOT NULL,
				uci TEXT NOT NULL,
				fen TEXT NOT NULL,
				whiteMs INTEGER NOT NULL,
				blackMs INTEGER NOT NULL,
				timestamp INTEGER NOT NULL
			);
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS chat (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				senderId TEXT NOT NULL,
				senderName TEXT NOT NULL,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				timestamp INTEGER NOT NULL
			);
		`);

		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as Session | undefined;
			if (attachment?.playerId && attachment.role) this.sessions.set(ws, attachment);
		}

		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	/**
	 * Initialize a freshly created match. Idempotent — a second call on an
	 * already-initialized instance is a no-op, so callers (Matchmaker) can
	 * safely retry `getByName(matchId).init(...)` without side effects.
	 *
	 * Also registers the match with the `GameLobby` singleton DO for the
	 * spectator TV, when the game is a rated human-vs-human match.
	 */
	async init(match: MatchInit): Promise<void> {
		const exists = this.getMeta();
		if (exists) return;

		const now = Date.now();
		// P5-B: register with GameLobby for spectator TV (rated human games only).
		if (match.mode === 'rated' && !match.whiteId.startsWith('bot:') && !match.blackId.startsWith('bot:')) {
			this.env.GAME_LOBBY.getByName('global').registerMatch({
				matchId: match.matchId,
				whiteName: match.whiteName,
				blackName: match.blackName,
				whiteRating: match.whiteRating,
				blackRating: match.blackRating,
				timeControlMs: match.timeControlMs,
				startedAt: now,
			}).catch((e) => log.error('lobby.register_failed', { matchId: match.matchId, error: String(e) }));
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO meta (matchId, mode, whiteId, blackId, whiteName, blackName, whiteRating, blackRating, whiteRatingDelta, blackRatingDelta, whiteGames, blackGames, status, fen, turn, timeControlMs, whiteMs, blackMs, lastMoveAt, startedAt, endedAt, result, endReason, drawOfferBy, ratingRecorded, ply)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'playing', ?, 'w', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0)`,
			match.matchId,
			match.mode,
			match.whiteId,
			match.blackId,
			match.whiteName,
			match.blackName,
			match.whiteRating,
			match.blackRating,
			match.whiteGames,
			match.blackGames,
			START_FEN,
			match.timeControlMs,
			match.timeControlMs,
			match.timeControlMs,
			now,
			now,
		);

		await this.scheduleClock(match.timeControlMs);
	}

	/** Fetch the current game state snapshot (used by REST/SSR reads, not WebSocket). */
	async getState(): Promise<GameState | { status: 'not_found' }> {
		const meta = this.getMeta();
		if (!meta) return { status: 'not_found' };
		return this.snapshot(meta);
	}

	/**
	 * Evaluate an arbitrary FEN position using a fast, shallow negamax search
	 * (used for the client-side eval bar; not part of move validation).
	 *
	 * @param fen - Position to evaluate.
	 * @returns Centipawn score from white's perspective (positive = white
	 *   favored), capped to ±9999 so the UI can render "M" for near-mate
	 *   positions cleanly, plus the engine's suggested best move in UCI.
	 */
	async getEval(fen: string): Promise<{ scoreCp: number; bestMove: string | null }> {
		const evalConfig = {
			id: 'bot:edge-eval',
			name: 'Eval',
			bio: '',
			rating: 0,
			maxDepth: 3,
			timeBudgetMs: 250,
			useBook: false,
			useEndgame: false,
			useTT: true,
			useQuiescence: 'captures+checks' as const,
			useNullMove: false,
			blunderRate: 0,
			eval: { pst: true, mobility: true, kingSafety: true, pawnStructure: true },
		};
		const result = searchWithScore(fen, evalConfig);
		if (!result) return { scoreCp: 0, bestMove: null };
		const capped = Math.max(-9999, Math.min(9999, result.scoreCp));
		const bestMove = `${result.from}${result.to}${result.promotion ?? ''}`;
		return { scoreCp: capped, bestMove };
	}

	/** Build and return the game's PGN transcript, for download/export. */
	async getPgn(): Promise<{ pgn: string; fen: string; matchId: string } | { status: 'not_found' }> {
		const meta = this.getMeta();
		if (!meta) return { status: 'not_found' };
		const moves = this.ctx.storage.sql
			.exec<{ ply: number; san: string }>(`SELECT ply, san FROM moves ORDER BY ply ASC`)
			.toArray();
		const pgn = buildPgn(meta, moves);
		return { pgn, fen: meta.fen, matchId: meta.matchId };
	}

	/**
	 * Upgrade an incoming request to a WebSocket connection for a player or
	 * spectator. Determines the caller's role from their session cookie
	 * (players) or assigns a spectator role with an ephemeral id. Tags the
	 * accepted WebSocket with `role:*` and `match:{id}` so hibernation-aware
	 * broadcasts can target specific audiences without an in-memory registry.
	 */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}

		const meta = this.getMeta();
		if (!meta) return new Response('Match not found', { status: 404 });

		const url = new URL(request.url);
		// Spectators have no signed session — fall back to an ephemeral id.
		const playerId = (await resolvePlayerId(request, this.env.AUTH_SECRET)) ?? crypto.randomUUID();
		const role = this.roleFor(meta, playerId);
		const name = role === 'white' ? meta.whiteName : role === 'black' ? meta.blackName : safeUsername(url.searchParams.get('username') ?? 'Spectator');
		const session: Session = { playerId, role, name };
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		// P5-A: tag each WebSocket by role for efficient hibernation-aware broadcasts.
		// getWebSockets('role:spectator') wakes only spectators; players are lightweight.
		const tags = [`role:${role}`, `match:${meta.matchId}`];
		this.ctx.acceptWebSocket(server, tags);
		server.serializeAttachment(session);
		this.sessions.set(server, session);

		this.send(server, { type: 'hello', you: role, state: this.snapshot(meta), chat: this.recentChat() });
		this.broadcastPresence();

		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Handle an inbound WebSocket message: `move`, `resign`, draw
	 * offer/accept/decline, or `chat`. State-changing actions run inside
	 * `blockConcurrencyWhile` so they cannot interleave with the clock alarm
	 * or another concurrent message on the same instance.
	 */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const session = this.sessions.get(ws);
		if (!session) return;

		const raw = String(message);
		if (raw.length > 4096) {
			this.send(ws, { type: 'error', code: 'message_too_large', message: 'Message too large.' });
			return;
		}

		let parsed: ClientMessage;
		try {
			parsed = JSON.parse(raw);
		} catch {
			this.send(ws, { type: 'error', code: 'bad_json', message: 'Invalid JSON.' });
			return;
		}
		// Reject anything that isn't a well-formed { type: string, ... } message (QR-9).
		if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
			this.send(ws, { type: 'error', code: 'bad_message', message: 'Malformed message.' });
			return;
		}

		if (parsed.type === 'chat') {
			this.handleChat(session, parsed.text);
			return;
		}

		if (session.role === 'spectator') {
			this.send(ws, { type: 'error', code: 'spectator_readonly', message: 'Spectators can watch and chat, but cannot play.' });
			return;
		}

		const role: PlayerColor = session.role;
		const action = parsed;
		// Serialize all state-changing input so concurrent messages (and the clock
		// alarm) cannot interleave around the awaits in handleMove/endGame (QR-10).
		await this.ctx.blockConcurrencyWhile(async () => {
			const meta = this.getMeta();
			if (!meta || meta.status !== 'playing') return;

			if (action.type === 'move') await this.handleMove(ws, role, action, meta);
			else if (action.type === 'resign') await this.endGame(resultForWinner(oppositeColor(role)), `${role} resigned`);
			else if (action.type === 'offer_draw') this.offerDraw(role);
			else if (action.type === 'accept_draw') await this.acceptDraw(role, meta);
			else if (action.type === 'decline_draw') this.declineDraw(role);
		});
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.sessions.delete(ws);
		this.broadcastPresence();
	}

	/**
	 * Alarm handler — drives everything time-based for this match:
	 * - While playing: flag-fall detection (clock hits zero) and a
	 *   pre-first-move abandonment timeout.
	 * - After the game ends: retries rating recording, then R2 archiving,
	 *   then eventually deletes the DO's storage once the retention window
	 *   (7 days for archived/rated games, 24h otherwise) has elapsed.
	 */
	async alarm(): Promise<void> {
		// Serialize with inbound moves so a flag-fall and a move can't interleave (QR-10).
		await this.ctx.blockConcurrencyWhile(async () => {
			const meta = this.getMeta();
			if (!meta) return;

			if (meta.status === 'ended') {
				// Retry rating recording if it failed (QR-5).
				if (!meta.ratingRecorded && meta.result) {
					await this.recordRatings(meta.result).catch((error) =>
						log.error('game.ratings_retry_failed', { matchId: meta.matchId, error: String(error) }),
					);
					const after = this.getMeta();
					// Reschedule: if now recorded → try archive; else retry rating in 30s.
					const delay = after?.ratingRecorded ? 5000 : 30 * 1000;
					await this.ctx.storage.setAlarm(Date.now() + delay);
					return;
				}
				// Retry R2 archive if it wasn't written yet.
				if (!meta.archiveWritten) {
					await this.archiveToR2().catch((error) =>
						log.error('game.archive_retry_failed', { matchId: meta.matchId, error: String(error) }),
					);
					const after = this.getMeta();
					const archived = after?.archiveWritten ?? 0;
					const ttl = archived ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
					await this.ctx.storage.setAlarm(Date.now() + ttl);
					return;
				}
				// Cleanup: archived rated games kept 7 days; bot/unrated kept 24h.
				const keepMs = meta.archiveWritten ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
				if (meta.endedAt && Date.now() - meta.endedAt > keepMs) {
					await this.ctx.storage.deleteAll();
				}
				return;
			}

			const clocks = this.liveClocks(meta);
			const activeColor = turnName(meta.turn);
			const remaining = activeColor === 'white' ? clocks.whiteMs : clocks.blackMs;
			if (remaining <= 0) {
				await this.endGame(resultForWinner(oppositeColor(activeColor)), `${activeColor} lost on time`);
				return;
			}

			// Before the first move the clock is paused (QR-13); flag the player to
			// move if they never start within one full time control (abandonment).
			if (meta.ply === 0) {
				const abortMs = meta.startedAt + meta.timeControlMs - Date.now();
				if (abortMs <= 0) {
					await this.endGame(resultForWinner(oppositeColor(activeColor)), `${activeColor} abandoned the game`);
					return;
				}
				await this.scheduleClock(abortMs);
				return;
			}

			await this.scheduleClock(remaining);
		});
	}

	private async handleMove(ws: WebSocket, role: PlayerColor, parsed: Extract<ClientMessage, { type: 'move' }>, meta: MetaRow): Promise<void> {
		if (!Number.isSafeInteger(parsed.expectedPly) || parsed.expectedPly < 0) {
			this.send(ws, { type: 'error', code: 'stale_position', message: 'Move is missing a valid board version.' });
			this.send(ws, { type: 'state', state: this.snapshot(meta) });
			return;
		}

		const result = await this.applyMove({ role, source: 'human' }, parsed, meta);
		if (!result.ok) {
			this.send(ws, { type: 'error', code: result.code, message: result.message });
			this.send(ws, { type: 'state', state: this.snapshot(result.meta) });
			return;
		}

		if (result.ended) return;

		if (this.isBotTurn(result.meta)) {
			await this.makeBotMove(result.meta);
			return;
		}
		this.broadcast({ type: 'state', state: this.snapshot(result.meta) });
		await this.scheduleClock(result.meta.turn === 'w' ? result.meta.whiteMs : result.meta.blackMs);
	}

	private async applyMove(actor: MoveActor, input: MoveInput, meta: MetaRow): Promise<ApplyMoveResult> {
		if (meta.status !== 'playing') return { ok: false, code: 'game_over', message: 'This game is already over.', meta };
		if (input.expectedPly !== undefined && input.expectedPly !== meta.ply) {
			return { ok: false, code: 'stale_position', message: 'Board changed. Try again.', meta };
		}
		if (roleToTurn(actor.role) !== meta.turn) {
			return { ok: false, code: 'not_your_turn', message: 'It is not your turn.', meta };
		}

		const clocks = this.liveClocks(meta);
		const activeRemaining = actor.role === 'white' ? clocks.whiteMs : clocks.blackMs;
		if (activeRemaining <= 0) {
			await this.endGame(resultForWinner(oppositeColor(actor.role)), `${actor.role} lost on time`);
			return { ok: true, meta: this.getMeta() ?? meta, ended: true };
		}

		const move = validateMove(meta.fen, input.from, input.to, input.promotion, this.moveHistory());
		if (!move) return { ok: false, code: 'illegal_move', message: 'Illegal move.', meta };

		const now = Date.now();
		const ply = meta.ply + 1;
		// Persist the move and the new board atomically (QR-10): a crash between
		// these statements must not leave moves and meta inconsistent.
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				`INSERT INTO moves (ply, san, uci, fen, whiteMs, blackMs, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				ply,
				move.san,
				move.uci,
				move.fen,
				clocks.whiteMs,
				clocks.blackMs,
				now,
			);
			this.ctx.storage.sql.exec(
				`UPDATE meta SET fen = ?, turn = ?, whiteMs = ?, blackMs = ?, lastMoveAt = ?, drawOfferBy = NULL, ply = ? WHERE matchId = ?`,
				move.fen,
				move.turn,
				clocks.whiteMs,
				clocks.blackMs,
				now,
				ply,
				meta.matchId,
			);
		});

		if (move.endState.ended) {
			await this.endGame(move.endState.result, move.endState.reason);
			return { ok: true, meta: this.getMeta() ?? meta, ended: true };
		}

		const updated = this.getMeta();
		return { ok: true, meta: updated ?? meta, ended: false };
	}

	private async makeBotMove(meta: MetaRow): Promise<void> {
		const botId = meta.turn === 'w' ? meta.whiteId : meta.blackId;
		const config = botConfigFromId(botId);
		const clocksBefore = this.liveClocks(meta);
		const remaining = meta.turn === 'w' ? clocksBefore.whiteMs : clocksBefore.blackMs;
		const botMove = chooseBotMove(meta.fen, config.id.split(':edge-')[1] as any, remaining);
		if (!botMove) return;

		const result = await this.applyMove({ role: turnName(meta.turn), source: 'bot' }, botMove, meta);
		if (!result.ok || result.ended) return;
		this.broadcast({ type: 'state', state: this.snapshot(result.meta) });
		await this.scheduleClock(result.meta.turn === 'w' ? result.meta.whiteMs : result.meta.blackMs);
	}

	private handleChat(session: Session, text: string): void {
		if (typeof text !== 'string') return;
		const trimmed = text.trim().slice(0, 280);
		if (!trimmed) return;

		const now = Date.now();
		this.ctx.storage.sql.exec(
			`INSERT INTO chat (senderId, senderName, role, text, timestamp) VALUES (?, ?, ?, ?, ?)`,
			session.playerId,
			session.name,
			session.role,
			trimmed,
			now,
		);

		const id = this.ctx.storage.sql.exec<{ id: number }>(`SELECT last_insert_rowid() AS id`).one().id;
		this.broadcast({
			type: 'chat',
			message: { id, senderId: session.playerId, senderName: session.name, role: session.role, text: trimmed, timestamp: now },
		});
	}

	private offerDraw(role: PlayerColor): void {
		const meta = this.getMeta();
		if (!meta || meta.status !== 'playing') return;
		// FIDE: a draw may be offered on your own move (QR-14). Disallow offering on
		// the opponent's turn, and don't clobber an offer that is already pending.
		if (roleToTurn(role) !== meta.turn || meta.drawOfferBy) return;
		this.ctx.storage.sql.exec(`UPDATE meta SET drawOfferBy = ? WHERE matchId = ?`, role, meta.matchId);
		this.broadcast({ type: 'draw_offer', from: role });
	}

	private async acceptDraw(role: PlayerColor, meta: MetaRow): Promise<void> {
		if (!meta.drawOfferBy || meta.drawOfferBy === role) return;
		await this.endGame('1/2-1/2', 'draw agreed');
	}

	private declineDraw(role: PlayerColor): void {
		const meta = this.getMeta();
		if (!meta || !meta.drawOfferBy || meta.drawOfferBy === role) return;
		this.ctx.storage.sql.exec(`UPDATE meta SET drawOfferBy = NULL WHERE matchId = ?`, meta.matchId);
		this.broadcast({ type: 'draw_declined', by: role });
	}

	private async endGame(result: GameResult, reason: string): Promise<void> {
		const meta = this.getMeta();
		if (!meta || meta.status === 'ended') return;
		const clocks = this.liveClocks(meta);
		const now = Date.now();
		// 1) Persist the terminal state first — authoritative, must not depend on
		//    cross-DO rating or R2 write succeeding (QR-5).
		this.ctx.storage.sql.exec(
			`UPDATE meta SET status = 'ended', result = ?, endReason = ?, endedAt = ?, whiteMs = ?, blackMs = ? WHERE matchId = ?`,
			result,
			reason,
			now,
			clocks.whiteMs,
			clocks.blackMs,
			meta.matchId,
		);
		log.info('game.ended', { matchId: meta.matchId, result, reason, whiteId: meta.whiteId, blackId: meta.blackId });
		// P5-B: deregister from lobby when game ends.
		this.env.GAME_LOBBY.getByName('global').deregisterMatch(meta.matchId)
			.catch((e) => log.error('lobby.deregister_failed', { matchId: meta.matchId, error: String(e) }));
		// 2) Best-effort AI analysis queue — enqueue for async coaching (P4-C).
		//    Never blocks game end; only for rated human-vs-human games.
		if (meta.mode === 'rated' && !meta.whiteId.startsWith('bot:') && !meta.blackId.startsWith('bot:')) {
			const moves = this.ctx.storage.sql.exec<{ ply: number; san: string }>(`SELECT ply, san FROM moves ORDER BY ply ASC`).toArray();
			const pgn = buildPgn({ ...meta, status: 'ended', result, endReason: reason, endedAt: now }, moves);
			this.env.GAME_ANALYSIS_QUEUE?.send({
				matchId: meta.matchId,
				whiteName: meta.whiteName,
				blackName: meta.blackName,
				whiteRating: meta.whiteRating,
				blackRating: meta.blackRating,
				result,
				reason,
				pgn,
				plyCount: moves.length,
			}).catch((e) => log.error('game.analysis_queue_failed', { matchId: meta.matchId, error: String(e) }));
		}
		// 3) Best-effort rating recording — alarm retries on failure (QR-5).
		await this.recordRatings(result).catch((error) =>
			log.error('game.ratings_failed', { matchId: meta.matchId, error: String(error) }),
		);
		// 3) Best-effort R2 archive — archive the game record for replay after DO cleanup.
		await this.archiveToR2().catch((error) =>
			log.error('game.archive_failed', { matchId: meta.matchId, error: String(error) }),
		);
		// 4) Broadcast the final state and schedule either archive-then-cleanup (rated)
		//    or a near-term rating retry (unrated/failed).
		const finalMeta = this.getMeta() ?? meta;
		this.broadcast({ type: 'ended', result, reason, state: this.snapshot(finalMeta) });
		// Rated + archived: keep DO for 7 days (replay window) then delete.
		// Bot/unrated or archive failed: keep for 24h then delete.
		// Rating not yet recorded: retry in 30s.
		const archived = finalMeta.archiveWritten ?? 0;
		const ttl = !finalMeta.ratingRecorded ? 30 * 1000
			: archived ? 7 * 24 * 60 * 60 * 1000
			: 24 * 60 * 60 * 1000;
		await this.ctx.storage.setAlarm(now + ttl);
	}

	// P3-C: write immutable game record to R2 so replay works after DO cleanup.
	private async archiveToR2(): Promise<void> {
		if (!this.env.R2_ARCHIVE) return; // binding absent in some test envs
		const meta = this.getMeta();
		if (!meta) return;
		const moves = this.ctx.storage.sql
			.exec<{ ply: number; san: string; uci: string; fen: string; whiteMs: number; blackMs: number; timestamp: number }>(
				`SELECT ply, san, uci, fen, whiteMs, blackMs, timestamp FROM moves ORDER BY ply ASC`,
			)
			.toArray();
		const pgn = buildPgn(meta, moves);
		const archive = {
			matchId: meta.matchId,
			mode: meta.mode,
			whiteId: meta.whiteId,
			blackId: meta.blackId,
			whiteName: meta.whiteName,
			blackName: meta.blackName,
			whiteRating: meta.whiteRating,
			blackRating: meta.blackRating,
			whiteRatingDelta: meta.whiteRatingDelta,
			blackRatingDelta: meta.blackRatingDelta,
			result: meta.result,
			endReason: meta.endReason,
			timeControlMs: meta.timeControlMs,
			startedAt: meta.startedAt,
			endedAt: meta.endedAt,
			moves,
		};

		await Promise.all([
			this.env.R2_ARCHIVE.put(`games/${meta.matchId}.json`, JSON.stringify(archive), {
				httpMetadata: { contentType: 'application/json' },
				customMetadata: { result: meta.result ?? '*', matchId: meta.matchId },
			}),
			this.env.R2_ARCHIVE.put(`pgn/${meta.matchId}.pgn`, pgn, {
				httpMetadata: { contentType: 'application/x-chess-pgn' },
				customMetadata: { result: meta.result ?? '*', matchId: meta.matchId },
			}),
		]);

		// Mark archive written so the alarm knows the extended TTL applies.
		this.ensureMetaColumn('archiveWritten', 'INTEGER NOT NULL DEFAULT 0');
		this.ctx.storage.sql.exec(`UPDATE meta SET archiveWritten = 1 WHERE matchId = ?`, meta.matchId);
		log.info('game.archived', { matchId: meta.matchId });
	}

	private getMeta(): MetaRow | undefined {
		return this.ctx.storage.sql.exec<MetaRow>(`SELECT * FROM meta LIMIT 1`).toArray()[0];
	}

	// Full move list in UCI (from the start position), used so the engine can
	// detect threefold/fivefold repetition (which needs position history).
	private moveHistory(): string[] {
		return this.ctx.storage.sql
			.exec<{ uci: string }>(`SELECT uci FROM moves ORDER BY ply ASC`)
			.toArray()
			.map((row) => row.uci);
	}

	private snapshot(meta: MetaRow): GameState {
		const clocks = meta.status === 'playing' ? this.liveClocks(meta) : { whiteMs: meta.whiteMs, blackMs: meta.blackMs };
		const moves = this.ctx.storage.sql.exec<MoveRecord>(`SELECT ply, san, uci, fen, whiteMs, blackMs, timestamp FROM moves ORDER BY ply ASC`).toArray();
		return {
			matchId: meta.matchId,
			mode: meta.mode,
			status: meta.status,
			fen: meta.fen,
			turn: meta.turn,
			ply: meta.ply,
			whiteId: meta.whiteId,
			blackId: meta.blackId,
			whiteName: meta.whiteName,
			blackName: meta.blackName,
			whiteRating: meta.whiteRating,
			blackRating: meta.blackRating,
			whiteRatingDelta: meta.whiteRatingDelta,
			blackRatingDelta: meta.blackRatingDelta,
			whiteGames: meta.whiteGames,
			blackGames: meta.blackGames,
			whiteMs: clocks.whiteMs,
			blackMs: clocks.blackMs,
			timeControlMs: meta.timeControlMs as GameState['timeControlMs'],
			lastMoveAt: meta.lastMoveAt,
			startedAt: meta.startedAt,
			endedAt: meta.endedAt ?? undefined,
			result: meta.result ?? undefined,
			endReason: meta.endReason ?? undefined,
			moves,
			presence: this.presence(),
		};
	}

	private liveClocks(meta: MetaRow): { whiteMs: number; blackMs: number } {
		// The clock does not run until the first move is played (QR-13): the player
		// to move gets the full time control as a first-move / abort window rather
		// than bleeding time while their page is still loading.
		if (meta.ply === 0) return { whiteMs: meta.whiteMs, blackMs: meta.blackMs };
		const elapsed = Math.max(0, Date.now() - meta.lastMoveAt);
		if (meta.turn === 'w') return { whiteMs: Math.max(0, meta.whiteMs - elapsed), blackMs: meta.blackMs };
		return { whiteMs: meta.whiteMs, blackMs: Math.max(0, meta.blackMs - elapsed) };
	}

	private recentChat(): ChatMessage[] {
		return this.ctx.storage.sql
			.exec<ChatMessage>(`SELECT id, senderId, senderName, role, text, timestamp FROM chat ORDER BY id DESC LIMIT 50`)
			.toArray()
			.reverse();
	}

	private roleFor(meta: MetaRow, playerId: string): Role {
		if (playerId === meta.whiteId) return 'white';
		if (playerId === meta.blackId) return 'black';
		return 'spectator';
	}

	private presence(): PresenceState {
		// P5-A: use tag-indexed getWebSockets for accurate counts that survive hibernation.
		const whiteOnline = this.ctx.getWebSockets('role:white').length > 0;
		const blackOnline = this.ctx.getWebSockets('role:black').length > 0;
		const spectators = this.ctx.getWebSockets('role:spectator').length;
		return { whiteOnline, blackOnline, spectators };
	}

	private async scheduleClock(ms: number): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + Math.max(1, ms));
	}

	private async recordRatings(result: GameResult): Promise<void> {
		const meta = this.getMeta();
		if (!meta || meta.ratingRecorded) return;

		const update = await this.env.MATCHMAKER.getByName('global').recordGame({
			matchId: meta.matchId,
			whiteId: meta.whiteId,
			blackId: meta.blackId,
			whiteName: meta.whiteName,
			blackName: meta.blackName,
			result,
			timeControlMs: meta.timeControlMs,
		});

		this.ctx.storage.sql.exec(
			`UPDATE meta SET whiteRating = ?, blackRating = ?, whiteRatingDelta = ?, blackRatingDelta = ?, whiteGames = ?, blackGames = ?, ratingRecorded = 1 WHERE matchId = ?`,
			update.white.rating,
			update.black.rating,
			update.white.delta,
			update.black.delta,
			update.white.games,
			update.black.games,
			meta.matchId,
		);
	}

	private isBotTurn(meta: MetaRow): boolean {
		return (meta.turn === 'w' && meta.whiteId.startsWith('bot:')) || (meta.turn === 'b' && meta.blackId.startsWith('bot:'));
	}

	private ensureMetaColumn(name: string, definition: string): void {
		try {
			this.ctx.storage.sql.exec(`ALTER TABLE meta ADD COLUMN ${name} ${definition}`);
		} catch {
			// Column already exists on objects created by newer code.
		}
	}

	private broadcastPresence(): void {
		const p = this.presence();
		this.broadcast({ type: 'presence', presence: p });
		// P5-B: sync spectator count to GameLobby for the spectator TV.
		const meta = this.getMeta();
		if (meta && meta.status === 'playing') {
			this.env.GAME_LOBBY.getByName('global').updateMatch(meta.matchId, p.spectators, meta.ply)
				.catch(() => { /* non-critical */ });
		}
	}

	private broadcast(message: ServerMessage): void {
		// P5-A: use tag-indexed getWebSockets() — wakes hibernated sockets only as needed.
		// This is the core hibernation pattern: no need to maintain an in-memory registry.
		for (const ws of this.ctx.getWebSockets()) this.send(ws, message);
	}

	// P5-A: targeted broadcast — send only to a specific role (e.g. players only).
	private broadcastToRole(message: ServerMessage, role: 'white' | 'black' | 'spectator'): void {
		for (const ws of this.ctx.getWebSockets(`role:${role}`)) this.send(ws, message);
	}

	private send(ws: WebSocket, message: ServerMessage): void {
		try {
			ws.send(JSON.stringify(message));
		} catch {
			this.sessions.delete(ws);
		}
	}
}

// P3-A: build a PGN string from stored meta + move rows.
function buildPgn(meta: MetaRow, moves: Array<{ ply: number; san: string }>): string {
	const date = meta.startedAt
		? new Date(meta.startedAt).toISOString().split('T')[0].replace(/-/g, '.')
		: '???';
	const result = meta.result ?? '*';
	const tcSec = Math.round(meta.timeControlMs / 1000);
	const headers = [
		`[Event "Cloudflare Chess"]`,
		`[Site "Cloudflare Chess"]`,
		`[Date "${date}"]`,
		`[White "${meta.whiteName}"]`,
		`[Black "${meta.blackName}"]`,
		`[Result "${result}"]`,
		`[WhiteElo "${meta.whiteRating}"]`,
		`[BlackElo "${meta.blackRating}"]`,
		`[TimeControl "${tcSec}"]`,
	].join('\n');

	// Build move-text: "1. e4 e5 2. Nf3 ..."
	const moveTokens: string[] = [];
	for (let i = 0; i < moves.length; i++) {
		if (i % 2 === 0) moveTokens.push(`${i / 2 + 1}.`);
		moveTokens.push(moves[i].san);
	}
	moveTokens.push(result);

	// Wrap at 80 chars
	const lines: string[] = [];
	let line = '';
	for (const token of moveTokens) {
		if (line && line.length + token.length + 1 > 80) { lines.push(line); line = token; }
		else { line = line ? `${line} ${token}` : token; }
	}
	if (line) lines.push(line);

	return `${headers}\n\n${lines.join('\n')}\n`;
}
