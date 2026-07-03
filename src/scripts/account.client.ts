import type { PublicProfile } from '../lib/messages';

const account = document.querySelector<HTMLElement>('[data-account]');
const accountLogin = document.querySelector<HTMLElement>('[data-account-login]');
const toggle = document.querySelector<HTMLButtonElement>('[data-account-toggle]');
const menu = document.querySelector<HTMLElement>('[data-account-menu]');
const idSlot = document.querySelector<HTMLElement>('[data-account-id]');
const ratingSlot = document.querySelector<HTMLElement>('[data-account-rating]');
const copyButton = document.querySelector<HTMLButtonElement>('[data-copy-account]');
const logoutButton = document.querySelector<HTMLButtonElement>('[data-logout]');

let currentPlayerId = '';

loadAccount();

toggle?.addEventListener('click', () => {
	if (!menu || !toggle) return;
	const expanded = menu.hidden;
	menu.hidden = !expanded;
	toggle.setAttribute('aria-expanded', String(expanded));
});

document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape' && menu && !menu.hidden) {
		menu.hidden = true;
		toggle?.setAttribute('aria-expanded', 'false');
		toggle?.focus();
	}
});

copyButton?.addEventListener('click', async () => {
	if (!currentPlayerId) return;
	await navigator.clipboard.writeText(currentPlayerId);
	if (copyButton) copyButton.textContent = 'Copied';
	window.setTimeout(() => {
		if (copyButton) copyButton.textContent = 'Copy ID';
	}, 1400);
});

logoutButton?.addEventListener('click', async () => {
	await fetch('/api/logout', { method: 'POST' });
	location.href = '/';
});

document.addEventListener('click', (event) => {
	if (!account || !menu || menu.hidden) return;
	if (!account.contains(event.target as Node)) {
		menu.hidden = true;
		toggle?.setAttribute('aria-expanded', 'false');
	}
});

async function loadAccount() {
	const response = await fetch('/api/me');
	if (!response.ok) return;
	const data = (await response.json()) as { profile: PublicProfile };
	const profile = data.profile;
	currentPlayerId = profile.playerId;
	if (idSlot) idSlot.textContent = profile.playerId;
	if (ratingSlot) ratingSlot.textContent = String(profile.rating);
	if (account) account.hidden = false;
	if (accountLogin) accountLogin.hidden = true;
}
