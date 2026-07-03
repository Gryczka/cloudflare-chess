import type { MatchmakerServerMessage, PublicProfile } from '../lib/messages';

const form = document.querySelector<HTMLFormElement>('#matchmake-form');
const username = document.querySelector<HTMLInputElement>('#username');
const statusText = document.querySelector<HTMLElement>('#matchmake-status');
const playerSummary = document.querySelector<HTMLElement>('#player-summary');
const cancelButton = document.querySelector<HTMLButtonElement>('#cancel-matchmaking');
const botButton = document.querySelector<HTMLElement>('.bot-button');
const waitingIllustration = document.querySelector<HTMLElement>('#waiting-illustration');

let socket: WebSocket | undefined;
let waitStarted = 0;
let waitTimer: number | undefined;

const savedName = localStorage.getItem('cf-chess-username');
if (username && savedName) username.value = savedName;
loadCurrentProfile();

form?.addEventListener('submit', (event) => {
	event.preventDefault();
	if (!username) return;

	const name = username.value.trim();
	const time = new FormData(form).get('time')?.toString() ?? '300000';
	if (!name) return;

	localStorage.setItem('cf-chess-username', name);
	startMatchmaking(name, time);
});

cancelButton?.addEventListener('click', () => {
	socket?.send(JSON.stringify({ type: 'cancel' }));
	socket?.close(1000, 'cancelled');
	resetUI('Matchmaking cancelled.');
});

async function startMatchmaking(name: string, time: string) {
	socket?.close();
	setWaiting(true);
	setStatus('Creating your player ID...');
	const enrolled = await ensureEnrollment(name);
	setStatus(`Playing as ${enrolled.playerId} · ${enrolled.profile.rating} Elo`);
	const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const url = `${protocol}//${location.host}/api/ws/matchmake?username=${encodeURIComponent(name)}&time=${encodeURIComponent(time)}`;
	socket = new WebSocket(url);
	waitStarted = Date.now();
	setStatus('Connecting to the matchmaker...');

	socket.addEventListener('open', () => {
		setStatus('Waiting for an opponent... 0s');
		waitTimer = window.setInterval(() => {
			const seconds = Math.floor((Date.now() - waitStarted) / 1000);
			setStatus(`Waiting for an opponent... ${seconds}s`);
		}, 1000);
	});

	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data) as MatchmakerServerMessage;
		if (message.type === 'waiting') {
			setStatus(`Waiting in the ${message.timeControlMs / 60000}+0 queue. ${message.queueSize} player${message.queueSize === 1 ? '' : 's'} waiting.`);
		}
		if (message.type === 'matched') {
			setStatus(`Matched as ${message.color}. Redirecting...`);
			location.href = `/match/${message.matchId}`;
		}
		if (message.type === 'error') setStatus(message.message);
	});

	socket.addEventListener('close', () => {
		if (!location.pathname.startsWith('/match/')) resetUI('Ready when you are.');
	});

	socket.addEventListener('error', () => resetUI('Could not connect to matchmaking. Try again.'));
}

function setWaiting(waiting: boolean) {
	if (form) form.querySelector<HTMLButtonElement>('.submit-button')!.hidden = waiting;
	if (botButton) botButton.hidden = waiting;
	if (cancelButton) cancelButton.hidden = !waiting;
	if (waitingIllustration) waitingIllustration.hidden = !waiting;
}

async function ensureEnrollment(name: string): Promise<{ playerId: string; secret?: string; profile: PublicProfile }> {
	const response = await fetch('/api/enroll', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: name }),
	});
	if (!response.ok) throw new Error('Could not enroll player.');
	const data = (await response.json()) as { playerId: string; secret?: string; profile: PublicProfile };
	// QR-1: a freshly minted account returns its recovery key exactly once. Surface
	// it so the player can save it (richer save-UX is UX-6). Without this they can
	// never recover the account.
	if (data.secret) surfaceRecoveryKey(data.secret);
	renderProfileSummary(data.profile, data.playerId);
	return data;
}

function surfaceRecoveryKey(secret: string) {
	// Use the global recovery-key dialog injected by Layout.astro (UX-6)
	if (typeof window.__showRecoveryKey === 'function') {
		window.__showRecoveryKey(secret);
		return;
	}
	// Fallback for environments where the dialog isn't available
	window.alert(
		`Save your recovery key — it is shown only once:\n\n${secret}\n\nKeep it somewhere safe. Use it at /login to recover this account.`,
	);
}

async function loadCurrentProfile() {
	const response = await fetch('/api/me');
	if (!response.ok) return;
	const data = (await response.json()) as { profile: PublicProfile };
	renderProfileSummary(data.profile, data.profile.playerId);
}

function renderProfileSummary(profile: PublicProfile | null | undefined, playerId: string) {
	if (!playerSummary || !profile) return;
	playerSummary.textContent = `Playing as ${playerId} · ${profile.rating} Elo${profile.isProvisional ? ' · provisional' : ''}`;
}

function resetUI(message: string) {
	if (waitTimer) window.clearInterval(waitTimer);
	setWaiting(false);
	setStatus(message);
}

function setStatus(message: string) {
	if (statusText) statusText.textContent = message;
}
