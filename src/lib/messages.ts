/**
 * Shared TypeScript types for the chess platform's WebSocket protocol and
 * data model. These types are the contract between:
 * - `ChessMatch` / `Matchmaker` Durable Objects (server, authoritative)
 * - Browser client scripts (`src/scripts/*.client.ts`)
 * - The D1 data-access layer (`src/lib/d1/*`)
 *
 * Keeping them in one module ensures the server and client never drift on
 * message shapes.
 */
export type Role = 'white' | 'black' | 'spectator';
export type PlayerColor = 'white' | 'black';
export type GameResult = '1-0' | '0-1' | '1/2-1/2';
export type GameStatus = 'waiting' | 'playing' | 'ended' | 'not_found';
export type BotDifficulty = 'pawn' | 'knight' | 'rook' | 'queen' | 'king';
export type GameMode = 'rated' | 'bot' | 'training' | 'analysis' | 'agent';

export type TimeControlMs = 60_000 | 180_000 | 300_000 | 600_000;

export type MoveRecord = {
	ply: number;
	san: string;
	uci: string;
	fen: string;
	whiteMs: number;
	blackMs: number;
	timestamp: number;
};

export type ChatMessage = {
	id: number;
	senderId: string;
	senderName: string;
	role: Role;
	text: string;
	timestamp: number;
};

export type PresenceState = {
	whiteOnline: boolean;
	blackOnline: boolean;
	spectators: number;
};

export type RatingSnapshot = {
	rating: number;
	delta: number;
	peakRating: number;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	botGames: number;
	botWins: number;
	botLosses: number;
	botDraws: number;
	isProvisional: boolean;
};

export type GameState = {
	matchId: string;
	mode: GameMode;
	status: GameStatus;
	fen: string;
	turn: 'w' | 'b';
	ply: number;
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
	whiteMs: number;
	blackMs: number;
	timeControlMs: TimeControlMs;
	lastMoveAt: number;
	startedAt: number;
	endedAt?: number;
	result?: GameResult;
	endReason?: string;
	moves: MoveRecord[];
	presence: PresenceState;
};

export type ClientMessage =
	| { type: 'move'; from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n'; expectedPly: number }
	| { type: 'resign' }
	| { type: 'offer_draw' }
	| { type: 'accept_draw' }
	| { type: 'decline_draw' }
	| { type: 'chat'; text: string };

export type ServerMessage =
	| { type: 'hello'; you: Role; state: GameState; chat: ChatMessage[] }
	| { type: 'state'; state: GameState }
	| { type: 'chat'; message: ChatMessage }
	| { type: 'presence'; presence: PresenceState }
	| { type: 'draw_offer'; from: PlayerColor }
	| { type: 'draw_declined'; by: PlayerColor }
	| { type: 'ended'; reason: string; result: GameResult; state: GameState }
	| { type: 'error'; code: string; message: string };

export type MatchmakerClientMessage =
	| { type: 'join'; username: string; timeControlMs: TimeControlMs }
	| { type: 'cancel' };

export type MatchmakerServerMessage =
	| { type: 'waiting'; queueSize: number; timeControlMs: TimeControlMs }
	| { type: 'matched'; matchId: string; color: PlayerColor }
	| { type: 'error'; code: string; message: string };

export type MatchInit = {
	matchId: string;
	whiteId: string;
	blackId: string;
	whiteName: string;
	blackName: string;
	whiteRating: number;
	blackRating: number;
	whiteGames: number;
	blackGames: number;
	mode: GameMode;
	timeControlMs: TimeControlMs;
};

export type RatingGameResult = {
	matchId: string;
	whiteId: string;
	blackId: string;
	whiteName: string;
	blackName: string;
	result: GameResult;
	// P3-E/F: time control so D1 can record per-TC ratings.
	timeControlMs?: number;
};

export type RatingGameUpdate = {
	white: RatingSnapshot;
	black: RatingSnapshot;
};

export type RatingHistoryEntry = {
	id: number;
	playerId: string;
	matchId: string;
	rating: number;
	delta: number;
	opponentId: string;
	result: GameResult;
	isBot: boolean;
	timestamp: number;
};

export type PublicProfile = {
	playerId: string;
	username: string;
	rating: number;
	peakRating: number;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	botGames: number;
	botWins: number;
	botLosses: number;
	botDraws: number;
	isProvisional: boolean;
	createdAt: number;
	updatedAt: number;
	// P3-F: per-time-control ratings (present when available)
	bulletRating?: number;
	blitzRating?: number;
	rapidRating?: number;
};

export type LeaderboardEntry = PublicProfile & {
	rank: number;
	winRate: number;
};

export type ProfileBundle = {
	profile: PublicProfile;
	recent: RatingHistoryEntry[];
};

export const TIME_CONTROLS: { label: string; value: TimeControlMs; description: string }[] = [
	{ label: '1+0', value: 60_000, description: 'Bullet' },
	{ label: '3+0', value: 180_000, description: 'Blitz' },
	{ label: '5+0', value: 300_000, description: 'Blitz' },
	{ label: '10+0', value: 600_000, description: 'Rapid' },
];

export function isTimeControl(value: number): value is TimeControlMs {
	return TIME_CONTROLS.some((control) => control.value === value);
}

export function roleToTurn(role: Role): 'w' | 'b' | undefined {
	if (role === 'white') return 'w';
	if (role === 'black') return 'b';
	return undefined;
}

export function oppositeColor(color: PlayerColor): PlayerColor {
	return color === 'white' ? 'black' : 'white';
}

export function resultForWinner(color: PlayerColor): GameResult {
	return color === 'white' ? '1-0' : '0-1';
}
