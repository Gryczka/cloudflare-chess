import { Chess } from 'chess.js';
import { BORDER_TYPE, COLOR, Chessboard, INPUT_EVENT_TYPE, PIECES_FILE_TYPE, type MoveInputEvent } from 'cm-chessboard/src/Chessboard.js';
// cm-chessboard Markers extension adds methods dynamically; import as untyped and
// use a helper that casts board to include the extension methods.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { MARKER_TYPE, Markers } = await import('cm-chessboard/src/extensions/markers/Markers.js') as any;

type MarkerType = { class: string; slice: string };
type BoardWithMarkers = Chessboard & {
	addMarker: (type: MarkerType, square: string) => void;
	removeMarkers: (type: MarkerType | undefined, square?: string) => void;
};
function boardM(): BoardWithMarkers | undefined {
	return board as BoardWithMarkers | undefined;
}
import type { ChatMessage, GameState, MoveRecord, Role, ServerMessage } from '../lib/messages';

type MatchPayload = {
	state: GameState;
	role: Role;
	username: string;
};

const data = readPayload();
const boardElement = document.querySelector<HTMLElement>('#chess-board');
const moveList = document.querySelector<HTMLElement>('#move-list');
const chatLog = document.querySelector<HTMLElement>('#chat-log');
const chatForm = document.querySelector<HTMLFormElement>('#chat-form');
const chatInput = document.querySelector<HTMLInputElement>('#chat-input');
const statusPill = document.querySelector<HTMLElement>('#game-status-pill');
const notice = document.querySelector<HTMLElement>('#game-notice');
const spectatorCount = document.querySelector<HTMLElement>('#spectator-count');
const drawBanner = document.querySelector<HTMLElement>('#draw-offer-banner');
const playerControls = document.querySelector<HTMLElement>('[data-player-controls]');
const premovePanel = document.querySelector<HTMLElement>('#premove-panel');
const premoveSummary = document.querySelector<HTMLElement>('#premove-summary');
const premoveList = document.querySelector<HTMLElement>('#premove-list');
const clearPremovesButton = document.querySelector<HTMLButtonElement>('#clear-premoves');
const postMatchSummary = document.querySelector<HTMLElement>('#post-match-summary');
const postMatchTitle = document.querySelector<HTMLElement>('#post-match-title');
const postMatchDetail = document.querySelector<HTMLElement>('#post-match-detail');
const victoryOverlay = document.querySelector<HTMLElement>('#victory-overlay');
const victoryKicker = document.querySelector<HTMLElement>('#victory-kicker');
const victoryTitle = document.querySelector<HTMLElement>('#victory-title');
const victorySubtitle = document.querySelector<HTMLElement>('#victory-subtitle');
const victoryRating = document.querySelector<HTMLElement>('#victory-rating');
const rematchBtn = document.querySelector<HTMLButtonElement>('#rematch-btn');
const shareBtn = document.querySelector<HTMLButtonElement>('#share-btn');
const pgnDownload = document.querySelector<HTMLAnchorElement>('#pgn-download');
const pgnCopy = document.querySelector<HTMLButtonElement>('#pgn-copy');
const mainContent = document.querySelector<HTMLElement>('#main-content');
const coachCard = document.querySelector<HTMLElement>('#coach-card');
const coachPending = document.querySelector<HTMLElement>('#coach-pending');
const coachOpening = document.querySelector<HTMLElement>('#coach-opening');
const coachSummary = document.querySelector<HTMLElement>('#coach-summary');
const coachMoment = document.querySelector<HTMLElement>('#coach-moment');
const coachTip = document.querySelector<HTMLElement>('#coach-tip');
const evalBarWrap = document.querySelector<HTMLElement>('#eval-bar-wrap');
const evalFill = document.querySelector<HTMLElement>('#eval-fill');
const evalLabel = document.querySelector<HTMLElement>('#eval-label');
const announcer = document.querySelector<HTMLElement>('#board-announcer');
const announcerAssertive = document.querySelector<HTMLElement>('#board-announcer-assertive');
const promoPicker = document.querySelector<HTMLElement>('#promo-picker');
const moveTextInput = document.querySelector<HTMLInputElement>('#move-text-input');
const moveTextSubmit = document.querySelector<HTMLButtonElement>('#move-text-submit');

let state = data.state;
let stateReceivedAt = Date.now();
// Definite assignment: connect() below always assigns socket before any event handler fires.
let socket!: WebSocket;
let board: Chessboard | undefined;
let clockTimer: number | undefined;
const MAX_PREMOVES = 3;
// UX-4: reconnect state
let reconnectAttempt = 0;
let reconnectTimer: number | undefined;
let isDisconnected = false;
// UX-4: pause clock display while disconnected
let clockPaused = false;
let premoveQueue: Array<{ from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n'; uci: string }> = [];
let pendingPremove: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n'; uci: string; sentAtPly: number } | undefined;

if (boardElement) {
	const orientation = data.role === 'black' ? COLOR.black : COLOR.white;
	board = new Chessboard(boardElement, {
		position: state.fen,
		orientation,
		assetsUrl: '/cm-chessboard/',
		style: {
			cssClass: 'default',
			showCoordinates: true,
			borderType: BORDER_TYPE.none,
			pieces: { type: PIECES_FILE_TYPE.svgSprite, file: 'pieces/staunty.svg', tileSize: 40 },
			animationDuration: 180,
		},
		extensions: [{ class: Markers, props: { autoMarkers: null, sprite: '/cm-chessboard/extensions/markers/markers.svg' } }],
	});

	if (data.role !== 'spectator') board.enableMoveInput(handleMoveInput, orientation);
}

connect();
renderState(state);
clockTimer = window.setInterval(renderClocks, 250);

// P5-D: Show a brief colo toast so players know which Cloudflare edge is serving them.
// We read the CF-Ray header from a HEAD request; the last 3 chars are the colo IATA code.
(async () => {
	try {
		const r = await fetch(location.href, { method: 'HEAD' });
		const ray = r.headers.get('CF-Ray');
		if (!ray) return;
		const colo = ray.split('-').pop(); // e.g. "SJC" from "...hash-SJC"
		if (!colo || colo.length < 2) return;
		const toast = document.createElement('div');
		toast.className = 'colo-toast';
		toast.setAttribute('aria-live', 'polite');
		toast.textContent = `Served from ${colo}`;
		document.body.appendChild(toast);
		// Fade in, hold 4 s, fade out.
		requestAnimationFrame(() => {
			toast.classList.add('colo-toast--visible');
			setTimeout(() => {
				toast.classList.remove('colo-toast--visible');
				toast.addEventListener('transitionend', () => toast.remove(), { once: true });
			}, 4000);
		});
	} catch { /* non-critical */ }
})();

chatForm?.addEventListener('submit', (event) => {
	event.preventDefault();
	const text = chatInput?.value.trim();
	if (!text) return;
	send({ type: 'chat', text });
	if (chatInput) chatInput.value = '';
});

document.querySelector('#offer-draw')?.addEventListener('click', () => send({ type: 'offer_draw' }));

// UX-12: in-app resign confirm dialog (replaces browser confirm())
const resignConfirmDialog = document.querySelector<HTMLElement>('#resign-confirm');
document.querySelector('#resign')?.addEventListener('click', () => {
	if (!resignConfirmDialog) { if (confirm('Resign this game?')) send({ type: 'resign' }); return; }
	mainContent?.setAttribute('inert', '');
	resignConfirmDialog.hidden = false;
	document.querySelector<HTMLButtonElement>('#resign-no')?.focus();
});
document.querySelector('#resign-yes')?.addEventListener('click', () => {
	if (resignConfirmDialog) { resignConfirmDialog.hidden = true; mainContent?.removeAttribute('inert'); }
	send({ type: 'resign' });
});
document.querySelector('#resign-no')?.addEventListener('click', () => {
	if (resignConfirmDialog) { resignConfirmDialog.hidden = true; mainContent?.removeAttribute('inert'); }
});
resignConfirmDialog?.addEventListener('keydown', (event: KeyboardEvent) => {
	if (event.key === 'Escape') {
		resignConfirmDialog.hidden = true;
		mainContent?.removeAttribute('inert');
	}
});
document.querySelector('#accept-draw')?.addEventListener('click', () => {
	send({ type: 'accept_draw' });
	hideDrawBanner();
});
document.querySelector('#decline-draw')?.addEventListener('click', () => {
	send({ type: 'decline_draw' });
	hideDrawBanner();
});
document.querySelector('#copy-link')?.addEventListener('click', async () => {
	await navigator.clipboard.writeText(location.href);
	setNotice('Match link copied.');
});
document.querySelector('#close-victory')?.addEventListener('click', closeVictory);

rematchBtn?.addEventListener('click', async () => {
	if (rematchBtn) { rematchBtn.textContent = 'Setting up…'; rematchBtn.disabled = true; }
	try {
		const res = await fetch(`/api/match/${state.matchId}/rematch`, { method: 'POST' });
		if (!res.ok) { throw new Error(await res.text()); }
		const data = (await res.json()) as { matchId: string };
		location.href = `/match/${data.matchId}`;
	} catch {
		if (rematchBtn) { rematchBtn.textContent = 'Rematch'; rematchBtn.disabled = false; }
		setNotice('Could not create rematch.');
	}
});

shareBtn?.addEventListener('click', async () => {
	try {
		await navigator.clipboard.writeText(location.href);
		if (shareBtn) shareBtn.textContent = 'Copied!';
		window.setTimeout(() => { if (shareBtn) shareBtn.textContent = 'Share'; }, 1800);
	} catch {
		setNotice('Copy failed — share this URL: ' + location.href);
	}
});

// P3-A: PGN export wiring — set href when game ends, handle copy button
pgnCopy?.addEventListener('click', async () => {
	const pgnUrl = `/api/match/${state.matchId}/pgn`;
	try {
		const res = await fetch(pgnUrl);
		if (!res.ok) { setNotice('PGN not available yet.'); return; }
		const text = await res.text();
		await navigator.clipboard.writeText(text);
		if (pgnCopy) pgnCopy.textContent = 'Copied!';
		window.setTimeout(() => { if (pgnCopy) pgnCopy.textContent = 'Copy PGN'; }, 1800);
	} catch {
		setNotice('Could not copy PGN.');
	}
});
clearPremovesButton?.addEventListener('click', () => clearPremoves('Premoves cleared.'));

// SAN/UCI text input (UX-3)
function submitTextMove() {
	if (!moveTextInput) return;
	const raw = moveTextInput.value.trim();
	if (!raw) return;
	// Try UCI (e.g. e2e4, e7e8q)
	const uciMatch = raw.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
	if (uciMatch) {
		const from = uciMatch[1].toLowerCase();
		const to = uciMatch[2].toLowerCase();
		const promo = uciMatch[3]?.toLowerCase() as 'q' | 'r' | 'b' | 'n' | undefined;
		tryTextMove(from, to, promo);
		return;
	}
	// Try SAN (e.g. Nf3, e4, O-O)
	try {
		const chess = new Chess(state.fen);
		const move = chess.move(raw);
		if (move) tryTextMove(move.from, move.to, move.promotion as 'q' | 'r' | 'b' | 'n' | undefined);
		else setNotice('Unrecognised move: ' + raw);
	} catch {
		setNotice('Unrecognised move: ' + raw);
	}
}

function tryTextMove(from: string, to: string, promotion?: 'q' | 'r' | 'b' | 'n') {
	if (!isOurTurn()) { setNotice('Not your turn.'); return; }
	const move = validateLocalMove(state.fen, from, to, promotion);
	if (!move) { setNotice('Illegal move.'); return; }
	// If promotion pawn and no piece specified, open picker
	if (!promotion && promotionSquare(state.fen, from, to)) {
		openPromoPicker(from, to);
		return;
	}
	send({ type: 'move', from, to, expectedPly: state.ply, ...(promotion ? { promotion } : {}) });
	if (moveTextInput) moveTextInput.value = '';
}

moveTextInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitTextMove(); } });
moveTextSubmit?.addEventListener('click', submitTextMove);

// UX-4: beforeunload guard — warn if active player during game
window.addEventListener('beforeunload', (event) => {
	if (data.role !== 'spectator' && state.status === 'playing') {
		event.preventDefault();
	}
});

function showReconnectBanner(text: string) {
	isDisconnected = true;
	clockPaused = true;
	const banner = document.getElementById('reconnect-banner');
	if (banner) { banner.textContent = text; banner.hidden = false; }
}

function hideReconnectBanner() {
	isDisconnected = false;
	clockPaused = false;
	const banner = document.getElementById('reconnect-banner');
	if (banner) banner.hidden = true;
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	// exponential back-off: 1s, 2s, 4s, 8s, capped at 16s
	const delay = Math.min(1000 * 2 ** reconnectAttempt, 16000);
	reconnectAttempt++;
	showReconnectBanner(`Reconnecting… (attempt ${reconnectAttempt})`);
	reconnectTimer = window.setTimeout(() => {
		reconnectTimer = undefined;
		connect();
	}, delay);
}

function connect() {
	const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const url = `${protocol}//${location.host}/api/ws/match/${state.matchId}?username=${encodeURIComponent(data.username)}`;
	socket = new WebSocket(url);

	socket.addEventListener('open', () => {
		reconnectAttempt = 0;
		hideReconnectBanner();
	});

	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data as string) as ServerMessage;
		if (message.type === 'hello') {
			handleStateMessage(message.state);
			renderChat(message.chat);
		}
		if (message.type === 'state') {
			handleStateMessage(message.state);
		}
		if (message.type === 'presence') {
			state.presence = message.presence;
			renderPresence();
		}
		if (message.type === 'chat') appendChat(message.message);
		if (message.type === 'draw_offer' && message.from !== data.role) showDrawBanner();
		if (message.type === 'draw_declined') setNotice(`${message.by} declined the draw offer.`);
		if (message.type === 'ended') {
			state = message.state;
			stateReceivedAt = Date.now();
			renderState(state);
			stopClockTimer();
			renderClocks();
			setNotice(`Game over: ${message.reason} (${message.result})`);
			announce(`Game over. ${sentenceCase(message.reason)}. Result: ${message.result}`, true);
			showVictory(message.result, message.reason, state);
		}
		if (message.type === 'error') {
			if (['illegal_move', 'stale_position', 'not_your_turn'].includes(message.code)) {
				if (pendingPremove) premoveQueue.shift();
				pendingPremove = undefined;
				renderPremoves();
				board?.setPosition(state.fen, true);
			}
			setNotice(message.message);
		}
	});

	socket.addEventListener('close', () => {
		// Only reconnect while the game is still in play
		if (state.status !== 'ended') scheduleReconnect();
		else setNotice('Disconnected.');
	});
	socket.addEventListener('error', () => {
		setNotice('WebSocket error.');
	});
}

function handleMoveInput(event: MoveInputEvent) {
	if (event.type === INPUT_EVENT_TYPE.moveInputStarted) {
		const allowed = isPlayer() && state.status === 'playing' && ownsSourcePiece(state.fen, event.squareFrom);
		if (allowed && board && event.squareFrom) {
			// Show legal-move dots (UX-9)
			boardM()?.removeMarkers(undefined, MARKER_TYPE.dot);
			boardM()?.addMarker(MARKER_TYPE.framePrimary, event.squareFrom);
			try {
				const chess = new Chess(state.fen);
				chess.moves({ square: event.squareFrom as Parameters<Chess['get']>[0], verbose: true })
					.forEach((m) => boardM()?.addMarker(MARKER_TYPE.dot, m.to));
			} catch { /* ignore */ }
		}
		return allowed;
	}
	if (event.type === INPUT_EVENT_TYPE.moveInputCanceled) {
		if (board) {
			boardM()?.removeMarkers(undefined, MARKER_TYPE.dot);
			boardM()?.removeMarkers(undefined, MARKER_TYPE.framePrimary);
		}
		return true;
	}
	if (event.type === INPUT_EVENT_TYPE.validateMoveInput && event.squareFrom && event.squareTo) {
		// Remove selection markers
		boardM()?.removeMarkers(undefined, MARKER_TYPE.dot);
		boardM()?.removeMarkers(undefined, MARKER_TYPE.framePrimary);
		if (!isOurTurn()) {
			return queuePremove(event.squareFrom, event.squareTo);
		}
		const squareFrom = event.squareFrom;
		const squareTo = event.squareTo;
		// Show promotion picker for pawn promotions instead of defaulting to queen (QR-12)
		if (promotionSquare(state.fen, squareFrom, squareTo)) {
			const testMove = validateLocalMove(state.fen, squareFrom, squareTo, 'q');
			if (!testMove) { board?.setPosition(state.fen, true); setNotice('Illegal move.'); return false; }
			openPromoPicker(squareFrom, squareTo);
			return true;
		}
		const move = validateLocalMove(state.fen, squareFrom, squareTo, undefined);
		if (!move) {
			board?.setPosition(state.fen, true);
			setNotice('Illegal move.');
			return false;
		}
		send({ type: 'move', from: squareFrom, to: squareTo, expectedPly: state.ply });
		return true;
	}
	return true;
}

function send(message: Record<string, unknown>) {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function handleStateMessage(nextState: GameState) {
	reconcilePendingPremove(nextState);
	const prevPly = state.ply;
	state = nextState;
	stateReceivedAt = Date.now();
	renderState(state);
	flushPremoveIfTurn();
	// P4-A: update eval bar after each move
	if (nextState.status === 'playing') updateEvalBar(nextState.fen);
	// Announce new move (UX-3)
	if (nextState.ply > prevPly) {
		const lastMove = nextState.moves[nextState.moves.length - 1];
		if (lastMove) {
			const mover = lastMove.ply % 2 === 1 ? 'White' : 'Black';
			const chess = (() => { try { return new Chess(nextState.fen); } catch { return null; } })();
			const inCheck = chess?.inCheck() ?? false;
			const inCheckmate = chess?.isCheckmate() ?? false;
			const msg = `${mover} plays ${lastMove.san}${inCheckmate ? '. Checkmate!' : inCheck ? '. Check!' : ''}`;
			announce(msg, inCheckmate || inCheck);
		}
	}
}

function renderBoardMarkers(nextState: GameState) {
	if (!board) return;
	// Clear all existing markers
	boardM()?.removeMarkers(undefined, MARKER_TYPE.square);
	boardM()?.removeMarkers(undefined, MARKER_TYPE.framePrimary);
	boardM()?.removeMarkers(undefined, MARKER_TYPE.frameDanger);
	boardM()?.removeMarkers(undefined, MARKER_TYPE.dot);
	// Last-move highlight
	const lastMove = nextState.moves[nextState.moves.length - 1];
	if (lastMove?.uci && lastMove.uci.length >= 4) {
		const from = lastMove.uci.slice(0, 2);
		const to = lastMove.uci.slice(2, 4);
		boardM()?.addMarker(MARKER_TYPE.square, from);
		boardM()?.addMarker(MARKER_TYPE.square, to);
	}
	// Check highlight — mark king square danger when in check
	if (nextState.fen) {
		try {
			const chess = new Chess(nextState.fen);
			if (chess.inCheck()) {
				// Find king of side to move
				const turn = chess.turn();
				const squares = chess.board().flat();
				for (const sq of squares) {
					if (sq?.type === 'k' && sq.color === turn) {
						boardM()?.addMarker(MARKER_TYPE.frameDanger, sq.square);
					}
				}
			}
		} catch { /* ignore */ }
	}
}

// P4-E: Coach card — poll for AI analysis and render when ready.
function startCoachPolling(matchId: string) {
	if (!coachCard || data.role === 'spectator') return;
	// Only show for rated human games (bot games don't get coaching).
	if (state.mode === 'bot') return;
	coachCard.hidden = false;
	if (coachPending) coachPending.hidden = false;
	if (coachOpening) coachOpening.hidden = true;
	if (coachSummary) coachSummary.hidden = true;
	if (coachMoment) coachMoment.hidden = true;
	if (coachTip) coachTip.hidden = true;

	document.getElementById('coach-dismiss')?.addEventListener('click', () => {
		if (coachCard) coachCard.hidden = true;
	});

	let attempts = 0;
	const maxAttempts = 24; // poll for up to 2 minutes (5s intervals)
	const poll = async () => {
		if (attempts++ >= maxAttempts) return;
		try {
			const res = await fetch(`/api/match/${matchId}/analysis`);
			if (res.status === 202) { window.setTimeout(poll, 5000); return; }
			if (!res.ok) return;
			const data = await res.json() as {
				openingName?: string; summary?: string;
				keyMoment?: string; tip?: string;
			};
			if (coachPending) coachPending.hidden = true;
			if (coachOpening && data.openingName) { coachOpening.textContent = data.openingName; coachOpening.hidden = false; }
			if (coachSummary && data.summary) { coachSummary.textContent = data.summary; coachSummary.hidden = false; }
			if (coachMoment && data.keyMoment) { coachMoment.textContent = `Key moment: ${data.keyMoment}`; coachMoment.hidden = false; }
			if (coachTip && data.tip) { coachTip.textContent = `💡 ${data.tip}`; coachTip.hidden = false; }
		} catch { /* non-critical */ }
	};
	window.setTimeout(poll, 5000); // first check after 5s
}

// P4-A: eval bar — fetch and render centipawn evaluation for a given FEN.
let evalDebounce: number | undefined;
function updateEvalBar(fen: string) {
	if (!evalBarWrap || !evalFill || !evalLabel) return;
	if (evalDebounce) window.clearTimeout(evalDebounce);
	evalDebounce = window.setTimeout(async () => {
		try {
			const res = await fetch(`/api/match/${state.matchId}/eval?fen=${encodeURIComponent(fen)}`);
			if (!res.ok) return;
			const { scoreCp } = (await res.json()) as { scoreCp: number };
			renderEvalBar(scoreCp);
		} catch { /* non-critical */ }
	}, 400);
}

function renderEvalBar(scoreCp: number) {
	if (!evalBarWrap || !evalFill || !evalLabel) return;
	evalBarWrap.hidden = false;
	// Map centipawns to a fill percentage: 0cp=50%, ±900cp≈~90%/10%
	// Use a sigmoid-like compression so extreme scores don't peg to 0/100.
	const pct = 50 + 50 * Math.tanh(scoreCp / 400);
	evalFill.style.width = `${pct.toFixed(1)}%`;
	// Label: show pawns (cp/100), capped, or "M" for near-mate
	const abs = Math.abs(scoreCp);
	if (abs >= 9000) {
		evalLabel.textContent = (scoreCp > 0 ? '+' : '-') + 'M';
	} else {
		const pawns = scoreCp / 100;
		evalLabel.textContent = (pawns > 0 ? '+' : '') + pawns.toFixed(1);
	}
}

function renderState(nextState: GameState) {
	board?.setPosition(nextState.fen, true);
	renderBoardMarkers(nextState);
	renderMoves(nextState.moves);
	renderPresence();
	renderClocks();
	if (statusPill) {
		statusPill.textContent = nextState.status === 'ended' ? nextState.result ?? 'Ended' : `${nextState.turn === 'w' ? 'White' : 'Black'} to move`;
	}
	if (playerControls) playerControls.hidden = data.role === 'spectator' || nextState.status === 'ended';
	renderRatings(nextState);
	if (nextState.status === 'ended') {
		stopClockTimer();
		clearPremoves();
		hideDrawBanner();
		renderPostMatch(nextState);
		initReplay(nextState);
		document.querySelector('.board-shell')?.classList.add('is-ended');
		document.querySelectorAll('[data-player-card]').forEach((card) => card.classList.add('is-ended'));
	} else {
		postMatchSummary?.setAttribute('hidden', '');
		document.querySelector('.board-shell')?.classList.remove('is-ended');
		document.querySelectorAll('[data-player-card]').forEach((card) => card.classList.remove('is-ended'));
	}
}

function queuePremove(from: string, to: string) {
	if (premoveQueue.length >= MAX_PREMOVES) {
		board?.setPosition(state.fen, true);
		setNotice(`Maximum ${MAX_PREMOVES} premoves queued.`);
		return false;
	}
	const premoveFen = asTurnFen(state.fen, roleTurn(data.role));
	const promotion = promotionForMove(premoveFen, from, to);
	const move = validateLocalMove(premoveFen, from, to, promotion);
	if (!move) {
		board?.setPosition(state.fen, true);
		setNotice('Illegal premove.');
		return false;
	}
	premoveQueue.push({ from, to, promotion, uci: `${from}${to}${promotion ?? ''}` });
	board?.setPosition(state.fen, true);
	renderPremoves();
	setNotice(`Premove queued: ${from}-${to}`);
	return false;
}

function flushPremoveIfTurn() {
	if (!isOurTurn() || pendingPremove || premoveQueue.length === 0 || state.status !== 'playing') return;
	if (socket.readyState !== WebSocket.OPEN) return;
	const next = premoveQueue[0];
	const promotion = promotionForMove(state.fen, next.from, next.to) ?? next.promotion;
	const move = validateLocalMove(state.fen, next.from, next.to, promotion);
	if (!move) {
		clearPremoves(`Premove ${next.from}-${next.to} is no longer legal.`);
		board?.setPosition(state.fen, true);
		return;
	}
	pendingPremove = { ...next, promotion, sentAtPly: state.ply };
	send({ type: 'move', from: next.from, to: next.to, expectedPly: state.ply, ...(promotion ? { promotion } : {}) });
}

function reconcilePendingPremove(nextState: GameState) {
	if (!pendingPremove) return;
	const expectedPly = pendingPremove.sentAtPly + 1;
	const confirmed = nextState.moves.some((move) => move.ply === expectedPly && move.uci === pendingPremove!.uci);
	if (confirmed) premoveQueue.shift();
	else if (nextState.ply <= pendingPremove.sentAtPly) return;
	else premoveQueue = [];
	pendingPremove = undefined;
	renderPremoves();
}

function renderPremoves() {
	if (!premovePanel || !premoveList || !premoveSummary) return;
	premovePanel.hidden = premoveQueue.length === 0;
	premoveSummary.textContent = `${premoveQueue.length} premove${premoveQueue.length === 1 ? '' : 's'} queued`;
	premoveList.replaceChildren();
	for (const move of premoveQueue) {
		const item = document.createElement('li');
		item.textContent = `${move.from}-${move.to}${move.promotion ? `=${move.promotion.toUpperCase()}` : ''}`;
		premoveList.appendChild(item);
	}
}

function clearPremoves(message?: string) {
	premoveQueue = [];
	pendingPremove = undefined;
	renderPremoves();
	if (message) setNotice(message);
}

function isPlayer() {
	return data.role === 'white' || data.role === 'black';
}

function isOurTurn(nextState = state) {
	return isPlayer() && nextState.turn === roleTurn(data.role);
}

function ownsSourcePiece(fen: string, square?: string) {
	if (!square || !isPlayer()) return false;
	try {
		const chess = new Chess(fen);
		// chess.js `Square` is an internal union type; cast via Parameters to stay
		// type-safe without importing the unexported Square alias.
		const piece = chess.get(square as Parameters<Chess['get']>[0]);
		return Boolean(piece && piece.color === roleTurn(data.role));
	} catch {
		return false;
	}
}

// ── P3-B: Replay / scrubber ────────────────────────────────────────────────
// Activated once on the first `status === 'ended'` state update.
// `replayPly` tracks the currently displayed ply:
//   -1 = start position (before any moves)
//   0..moves.length-1 = after move at that index
let replayActive = false;
let replayPly = -2; // sentinel — not yet initialised
let replayMoves: typeof state.moves = [];

function initReplay(finalState: GameState) {
	if (replayActive) return;
	replayActive = true;
	replayMoves = finalState.moves;
	replayPly = replayMoves.length - 1; // start at final position
	startCoachPolling(finalState.matchId);

	const toolbar = document.getElementById('replay-toolbar');
	if (toolbar) toolbar.hidden = false;

	// Make move-list cells clickable
	renderMovesReplayable(replayMoves);
	updateReplayUI();

	// Wire toolbar buttons
	document.getElementById('replay-start')?.addEventListener('click', () => setReplayPly(-1));
	document.getElementById('replay-prev')?.addEventListener('click', () => setReplayPly(replayPly - 1));
	document.getElementById('replay-next')?.addEventListener('click', () => setReplayPly(replayPly + 1));
	document.getElementById('replay-end')?.addEventListener('click', () => setReplayPly(replayMoves.length - 1));

	// Keyboard navigation (◀/▶) while board is in focus or no input is focused
	document.addEventListener('keydown', (event: KeyboardEvent) => {
		if (!replayActive) return;
		const tag = (document.activeElement as HTMLElement)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;
		if (event.key === 'ArrowLeft') { event.preventDefault(); setReplayPly(replayPly - 1); }
		if (event.key === 'ArrowRight') { event.preventDefault(); setReplayPly(replayPly + 1); }
		if (event.key === 'Home') { event.preventDefault(); setReplayPly(-1); }
		if (event.key === 'End') { event.preventDefault(); setReplayPly(replayMoves.length - 1); }
	});
}

function setReplayPly(ply: number) {
	replayPly = Math.max(-1, Math.min(replayMoves.length - 1, ply));
	updateReplayUI();
	const fen = replayPly === -1 ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
		: replayMoves[replayPly].fen;
	board?.setPosition(fen, true);
	updateEvalBar(fen);
	// Clear markers and set last-move highlight for replayed position
	boardM()?.removeMarkers(undefined, MARKER_TYPE.square);
	boardM()?.removeMarkers(undefined, MARKER_TYPE.frameDanger);
	if (replayPly >= 0) {
		const m = replayMoves[replayPly];
		if (m.uci.length >= 4) {
			boardM()?.addMarker(MARKER_TYPE.square, m.uci.slice(0, 2));
			boardM()?.addMarker(MARKER_TYPE.square, m.uci.slice(2, 4));
		}
	}
}

function updateReplayUI() {
	const counter = document.getElementById('replay-counter');
	if (counter) {
		counter.textContent = replayPly === -1
			? `Start`
			: `${replayPly + 1} / ${replayMoves.length}`;
	}
	const prev = document.getElementById('replay-prev') as HTMLButtonElement | null;
	const next = document.getElementById('replay-next') as HTMLButtonElement | null;
	const start = document.getElementById('replay-start') as HTMLButtonElement | null;
	const end = document.getElementById('replay-end') as HTMLButtonElement | null;
	if (prev) prev.disabled = replayPly <= -1;
	if (start) start.disabled = replayPly <= -1;
	if (next) next.disabled = replayPly >= replayMoves.length - 1;
	if (end) end.disabled = replayPly >= replayMoves.length - 1;
	// Highlight active move cell
	document.querySelectorAll('#move-list .move-cell').forEach((cell, i) => {
		// Each move-number cell is at i%3===0; white move at i%3===1; black at i%3===2
		const moveCellIdx = i % 3; // 0=number, 1=white, 2=black
		const pairIdx = Math.floor(i / 3);
		const ply = moveCellIdx === 1 ? pairIdx * 2 : pairIdx * 2 + 1; // 0-based ply
		const isActive = moveCellIdx !== 0 && ply === replayPly;
		cell.classList.toggle('is-replay-cursor', isActive);
	});
}

function renderMovesReplayable(moves: typeof state.moves) {
	if (!moveList) return;
	moveList.replaceChildren();
	for (let i = 0; i < moves.length; i += 2) {
		const moveNumber = document.createElement('li');
		moveNumber.className = 'move-cell move-number';
		moveNumber.textContent = `${i / 2 + 1}.`;
		const white = document.createElement('li');
		white.className = 'move-cell';
		white.textContent = moves[i]?.san ?? '';
		white.setAttribute('role', 'button');
		white.setAttribute('tabindex', '0');
		white.dataset.ply = String(i);
		const black = document.createElement('li');
		black.className = 'move-cell';
		black.textContent = moves[i + 1]?.san ?? '';
		if (moves[i + 1]) {
			black.setAttribute('role', 'button');
			black.setAttribute('tabindex', '0');
			black.dataset.ply = String(i + 1);
		}
		[white, black].forEach((cell) => {
			cell.addEventListener('click', () => {
				const p = Number(cell.dataset.ply);
				if (!Number.isNaN(p)) setReplayPly(p);
			});
			cell.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cell.click(); }
			});
		});
		moveList.appendChild(moveNumber);
		moveList.appendChild(white);
		moveList.appendChild(black);
	}
	moveList.scrollTop = moveList.scrollHeight;
}
// ── End replay ─────────────────────────────────────────────────────────────

function renderPostMatch(finalState: GameState) {
	if (!postMatchSummary || !postMatchTitle || !postMatchDetail) return;
	const result = finalState.result ?? 'ended';
	const reason = finalState.endReason ?? 'game ended';
	const won = (data.role === 'white' && result === '1-0') || (data.role === 'black' && result === '0-1');
	const lost = (data.role === 'white' && result === '0-1') || (data.role === 'black' && result === '1-0');
	// "You lost" is correct here — endReason already provides the specific cause.
	postMatchTitle.textContent = result === '1/2-1/2' ? 'Draw agreed' : won ? 'You won' : lost ? 'You lost' : 'Game over';
	postMatchDetail.textContent = `${sentenceCase(reason)} · ${result}`;
	postMatchSummary.hidden = false;
}

function renderRatings(nextState: GameState) {
	setRating('white-rating', nextState.whiteRating, 'white-rating-delta', nextState.whiteRatingDelta);
	setRating('black-rating', nextState.blackRating, 'black-rating-delta', nextState.blackRatingDelta);
}

function setRating(ratingId: string, rating: number, deltaId: string, delta: number) {
	const ratingElement = document.getElementById(ratingId);
	const deltaElement = document.getElementById(deltaId);
	if (ratingElement) ratingElement.textContent = String(rating);
	if (deltaElement) {
		deltaElement.textContent = delta === 0 ? '' : `${delta > 0 ? '+' : ''}${delta}`;
		deltaElement.classList.toggle('positive', delta > 0);
		deltaElement.classList.toggle('negative', delta < 0);
	}
}

function renderMoves(moves: MoveRecord[]) {
	if (!moveList) return;
	moveList.replaceChildren();
	for (let i = 0; i < moves.length; i += 2) {
		const moveNumber = document.createElement('li');
		moveNumber.className = 'move-cell move-number';
		moveNumber.textContent = `${i / 2 + 1}.`;
		const white = document.createElement('li');
		white.className = 'move-cell';
		white.textContent = moves[i]?.san ?? '';
		const black = document.createElement('li');
		black.className = 'move-cell';
		black.textContent = moves[i + 1]?.san ?? '';
		moveList.appendChild(moveNumber);
		moveList.appendChild(white);
		moveList.appendChild(black);
	}
	moveList.scrollTop = moveList.scrollHeight;
}

function renderChat(messages: ChatMessage[]) {
	if (!chatLog) return;
	chatLog.replaceChildren();
	for (const message of messages) appendChat(message);
}

function appendChat(message: ChatMessage) {
	if (!chatLog) return;
	const line = document.createElement('div');
	line.className = 'chat-line';
	line.dataset.role = message.role;
	const name = document.createElement('strong');
	name.textContent = message.role === 'spectator' ? `[watching] ${message.senderName}` : message.senderName;
	line.appendChild(name);
	line.appendChild(document.createTextNode(`: ${message.text}`));
	chatLog.appendChild(line);
	chatLog.scrollTop = chatLog.scrollHeight;
	// Show badge on chat tab if chat panel is currently hidden
	const chatPanel = document.getElementById('tab-chat');
	if (chatPanel?.hidden) {
		const badge = document.querySelector<HTMLElement>('[data-chat-badge]');
		if (badge) badge.hidden = false;
	}
}

function renderPresence() {
	updatePresence('white', state.presence.whiteOnline);
	updatePresence('black', state.presence.blackOnline);
	if (spectatorCount) spectatorCount.textContent = `${state.presence.spectators} watching`;
}

function updatePresence(color: 'white' | 'black', online: boolean) {
	const dot = document.querySelector(`[data-player-card='${color}'] .player-card__presence`);
	dot?.classList.toggle('is-online', online);
}

function renderClocks() {
	const elapsed = (state.status === 'playing' && !clockPaused) ? Date.now() - stateReceivedAt : 0;
	let whiteMs = state.whiteMs;
	let blackMs = state.blackMs;
	if (state.status === 'playing' && !clockPaused) {
		if (state.turn === 'w') whiteMs = Math.max(0, whiteMs - elapsed);
		else blackMs = Math.max(0, blackMs - elapsed);
	}
	setClock('white-clock', whiteMs);
	setClock('black-clock', blackMs);
	// UX-9: clock urgency classes
	setClockUrgency('white-clock', whiteMs);
	setClockUrgency('black-clock', blackMs);
	// UX-9: active-turn ring on player card
	document.querySelectorAll('[data-player-card]').forEach((card) => {
		const color = (card as HTMLElement).dataset.playerCard;
		const isActive = state.status === 'playing' && ((color === 'white' && state.turn === 'w') || (color === 'black' && state.turn === 'b'));
		(card as HTMLElement).classList.toggle('is-active-turn', isActive);
	});
}

function setClockUrgency(id: string, ms: number) {
	const el = document.getElementById(id);
	if (!el) return;
	el.classList.toggle('clock-urgent', ms > 0 && ms <= 10000);
	el.classList.toggle('clock-warning', ms > 10000 && ms <= 30000);
}

function stopClockTimer() {
	if (clockTimer) {
		window.clearInterval(clockTimer);
		clockTimer = undefined;
	}
}

function setClock(id: string, ms: number) {
	const clock = document.getElementById(id);
	if (clock) clock.textContent = formatClock(ms);
}

function formatClock(ms: number) {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const min = Math.floor(total / 60);
	const sec = total % 60;
	return `${min}:${String(sec).padStart(2, '0')}`;
}

function roleTurn(role: Role) {
	if (role === 'white') return 'w';
	if (role === 'black') return 'b';
	return 'x' as const;
}

function asTurnFen(fen: string, turn: 'w' | 'b' | 'x') {
	if (turn === 'x') return fen;
	const parts = fen.split(' ');
	parts[1] = turn;
	return parts.join(' ');
}

function validateLocalMove(fen: string, from: string, to: string, promotion?: 'q' | 'r' | 'b' | 'n') {
	try {
		const chess = new Chess(fen);
		return chess.move(promotion ? { from, to, promotion } : { from, to });
	} catch {
		return null;
	}
}

// Returns true if this move is a promotion (pawn reaching back rank)
function promotionSquare(fen: string, from: string, to: string): boolean {
	try {
		const chess = new Chess(fen);
		const piece = chess.get(from as Parameters<Chess['get']>[0]);
		if (!piece || piece.type !== 'p') return false;
		if (piece.color === 'w' && to.endsWith('8')) return true;
		if (piece.color === 'b' && to.endsWith('1')) return true;
		return false;
	} catch {
		return false;
	}
}

// Legacy: used by premove path — defaults to queen (premoves can't show picker)
function promotionForMove(fen: string, from: string, to: string): 'q' | undefined {
	return promotionSquare(fen, from, to) ? 'q' : undefined;
}

// Under-promotion picker state
let promoResolve: ((piece: 'q' | 'r' | 'b' | 'n') => void) | null = null;

function openPromoPicker(from: string, to: string) {
	if (!promoPicker) { send({ type: 'move', from, to, expectedPly: state.ply, promotion: 'q' }); return; }
	mainContent?.setAttribute('inert', '');
	promoPicker.hidden = false;
	const firstBtn = promoPicker.querySelector<HTMLButtonElement>('[data-promo]');
	firstBtn?.focus();
	promoResolve = (piece) => {
		promoPicker.hidden = true;
		mainContent?.removeAttribute('inert');
		send({ type: 'move', from, to, expectedPly: state.ply, promotion: piece });
		if (moveTextInput) moveTextInput.value = '';
	};
}

promoPicker?.addEventListener('click', (event) => {
	const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-promo]');
	if (!btn) return;
	const piece = btn.dataset.promo as 'q' | 'r' | 'b' | 'n';
	promoResolve?.(piece);
	promoResolve = null;
});

promoPicker?.addEventListener('keydown', (event: KeyboardEvent) => {
	if (event.key === 'Escape') {
		promoPicker.hidden = true;
		mainContent?.removeAttribute('inert');
		promoResolve = null;
		board?.setPosition(state.fen, true);
	}
});

// aria-live announcer helpers (UX-3)
function announce(text: string, assertive = false) {
	const el = assertive ? announcerAssertive : announcer;
	if (!el) return;
	el.textContent = '';
	window.requestAnimationFrame(() => { el.textContent = text; });
}

function showDrawBanner() {
	if (drawBanner) drawBanner.hidden = false;
}

function hideDrawBanner() {
	if (drawBanner) drawBanner.hidden = true;
}

function setNotice(message: string) {
	if (notice) notice.textContent = message;
}

let victoryPreviousFocus: HTMLElement | null = null;

function showVictory(result: string, reason: string, finalState: GameState) {
	if (!victoryOverlay || !victoryTitle || !victorySubtitle) return;
	const won = (data.role === 'white' && result === '1-0') || (data.role === 'black' && result === '0-1');
	const lost = (data.role === 'white' && result === '0-1') || (data.role === 'black' && result === '1-0');
	const draw = result === '1/2-1/2';

	if (victoryKicker) victoryKicker.textContent = draw ? 'Peace treaty signed' : won ? 'Victory secured' : lost ? 'Defeat recorded' : 'Final result';
	victoryTitle.textContent = draw ? 'Draw agreed.' : won ? 'You won.' : lost ? 'You fell.' : 'Game over.';
	victorySubtitle.textContent = `${sentenceCase(reason)}. ${result}`;
	if (victoryRating) {
		const delta = data.role === 'white' ? finalState.whiteRatingDelta : data.role === 'black' ? finalState.blackRatingDelta : 0;
		const rating = data.role === 'white' ? finalState.whiteRating : data.role === 'black' ? finalState.blackRating : undefined;
		victoryRating.textContent = rating ? `Elo ${rating} ${delta === 0 ? '' : `(${delta > 0 ? '+' : ''}${delta})`}` : 'Spectator mode';
	}
	// Show Rematch for non-spectators (UX-7)
	if (rematchBtn) rematchBtn.hidden = data.role === 'spectator';
	// P3-A: wire PGN download link
	if (pgnDownload) {
		pgnDownload.href = `/api/match/${finalState.matchId}/pgn`;
		pgnDownload.setAttribute('download', `match-${finalState.matchId.slice(0, 8)}.pgn`);
	}

	victoryPreviousFocus = document.activeElement as HTMLElement | null;
	victoryOverlay.hidden = false;
	// Make main content inert while dialog is open (UX-5)
	mainContent?.setAttribute('inert', '');
	// Move focus into dialog
	document.querySelector<HTMLButtonElement>('#close-victory')?.focus();

	if (won || draw) launchConfetti(won ? 96 : 48);
}

function closeVictory() {
	if (!victoryOverlay) return;
	victoryOverlay.hidden = true;
	mainContent?.removeAttribute('inert');
	// Restore focus to previous element (or board)
	const restore = victoryPreviousFocus ?? document.querySelector<HTMLElement>('#chess-board');
	restore?.focus();
}

// Focus trap inside victory dialog (UX-5)
victoryOverlay?.addEventListener('keydown', (event: KeyboardEvent) => {
	if (event.key === 'Escape') { closeVictory(); return; }
	if (event.key !== 'Tab') return;
	const focusable = Array.from(
		victoryOverlay.querySelectorAll<HTMLElement>('button:not([hidden]), [href], input, [tabindex]:not([tabindex="-1"])')
	).filter((el) => !el.hidden);
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (event.shiftKey) {
		if (document.activeElement === first) { event.preventDefault(); last.focus(); }
	} else {
		if (document.activeElement === last) { event.preventDefault(); first.focus(); }
	}
});

function launchConfetti(count: number) {
	const colors = ['#FF4801', '#FF7038', '#EBD5C1', '#521000', '#FEF7ED'];
	for (let i = 0; i < count; i++) {
		const piece = document.createElement('span');
		piece.className = 'confetti-piece';
		piece.style.left = `${Math.random() * 100}vw`;
		piece.style.background = colors[i % colors.length];
		piece.style.setProperty('--fall-drift', `${Math.random() * 240 - 120}px`);
		piece.style.setProperty('--fall-duration', `${1400 + Math.random() * 1800}ms`);
		piece.style.animationDelay = `${Math.random() * 220}ms`;
		document.body.appendChild(piece);
		window.setTimeout(() => piece.remove(), 3600);
	}
}

function sentenceCase(value: string) {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function readPayload(): MatchPayload {
	const element = document.querySelector<HTMLScriptElement>('#match-data');
	if (!element?.textContent) throw new Error('Missing match data');
	return JSON.parse(element.textContent) as MatchPayload;
}
