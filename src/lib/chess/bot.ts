/**
 * Bot opponent configuration and move selection.
 *
 * Five named difficulty tiers (`pawn` → `king`) each tune search depth, time
 * budget, opening-book usage, evaluation features, and an intentional
 * "blunder rate" so weaker bots feel human-like rather than just shallow.
 * Move selection first checks the opening book (`bot-opening.ts`), then falls
 * back to the negamax search (`bot-search.ts`).
 */
import { bookMove } from './bot-opening';
import { searchMove } from './bot-search';

export type BotDifficulty = 'pawn' | 'knight' | 'rook' | 'queen' | 'king';
export type BotMove = { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' };

export type BotConfig = {
	id: string;
	name: string;
	rating: number;
	bio: string;
	maxDepth: number;
	timeBudgetMs: number;
	useBook: boolean;
	useEndgame: boolean;
	useTT: boolean;
	useNullMove: boolean;
	useQuiescence: 'none' | 'captures' | 'captures+checks';
	eval: { pst: boolean; mobility: boolean; kingSafety: boolean; pawnStructure: boolean };
	blunderRate: number;
};

export const BOT_CONFIGS: Record<BotDifficulty, BotConfig> = {
	pawn: {
		id: 'bot:edge-pawn',
		name: 'Edge Pawn',
		rating: 800,
		bio: 'A fast, chaotic bot that sees captures but misses plans.',
		maxDepth: 1,
		timeBudgetMs: 30,
		useBook: false,
		useEndgame: false,
		useTT: false,
		useNullMove: false,
		useQuiescence: 'none',
		eval: { pst: false, mobility: false, kingSafety: false, pawnStructure: false },
		blunderRate: 0.35,
	},
	knight: {
		id: 'bot:edge-knight',
		name: 'Edge Knight',
		rating: 1200,
		bio: 'A practical club-level bot with basic development and tactics.',
		maxDepth: 2,
		timeBudgetMs: 100,
		useBook: true,
		useEndgame: false,
		useTT: false,
		useNullMove: false,
		useQuiescence: 'captures',
		eval: { pst: true, mobility: false, kingSafety: false, pawnStructure: false },
		blunderRate: 0.05,
	},
	rook: {
		id: 'bot:edge-rook',
		name: 'Edge Rook',
		rating: 1500,
		bio: 'Calculates deeper and values active piece play.',
		maxDepth: 3,
		timeBudgetMs: 250,
		useBook: true,
		useEndgame: false,
		useTT: false,
		useNullMove: false,
		useQuiescence: 'captures+checks',
		eval: { pst: true, mobility: true, kingSafety: false, pawnStructure: false },
		blunderRate: 0,
	},
	queen: {
		id: 'bot:edge-queen',
		name: 'Edge Queen',
		rating: 1800,
		bio: 'A sharp bot with king safety and pawn-structure judgment.',
		maxDepth: 4,
		timeBudgetMs: 500,
		useBook: true,
		useEndgame: true,
		useTT: false,
		useNullMove: false,
		useQuiescence: 'captures+checks',
		eval: { pst: true, mobility: true, kingSafety: true, pawnStructure: true },
		blunderRate: 0,
	},
	king: {
		id: 'bot:edge-king',
		name: 'Edge King',
		rating: 2100,
		bio: 'The strongest edge bot, using transpositions and pruning.',
		maxDepth: 5,
		timeBudgetMs: 700,
		useBook: true,
		useEndgame: true,
		useTT: true,
		useNullMove: true,
		useQuiescence: 'captures+checks',
		eval: { pst: true, mobility: true, kingSafety: true, pawnStructure: true },
		blunderRate: 0,
	},
};

export const BOT_DIFFICULTY_ORDER: BotDifficulty[] = ['pawn', 'knight', 'rook', 'queen', 'king'];

/**
 * Choose the bot's next move for a given position.
 *
 * @param fen - Current board position.
 * @param difficulty - Which bot tier is moving.
 * @param remainingMs - The bot's remaining clock time, used to cap search
 *   time budget so the bot never flags itself.
 * @returns The chosen move, or `null` if no legal move exists (shouldn't
 *   happen for a non-terminal position, but guards against edge cases).
 */
export function chooseBotMove(fen: string, difficulty: BotDifficulty, remainingMs?: number): BotMove | null {
	const config = BOT_CONFIGS[difficulty] ?? BOT_CONFIGS.knight;
	if (config.useBook) {
		const fromBook = bookMove(fen);
		if (fromBook) return fromBook;
	}
	return searchMove(fen, config, remainingMs);
}

/**
 * Look up a bot's full config from its player-id-style identifier
 * (e.g. `"bot:edge-queen"`). Falls back to `knight` for unrecognized ids.
 */
export function botConfigFromId(botId: string): BotConfig {
	const [, name] = botId.split(':edge-');
	if (name && name in BOT_CONFIGS) return BOT_CONFIGS[name as BotDifficulty];
	return BOT_CONFIGS.knight;
}

/** Type-guard: is `value` one of the known bot difficulty tiers? */
export function isBotDifficulty(value: unknown): value is BotDifficulty {
	return typeof value === 'string' && value in BOT_CONFIGS;
}
