// Small brand marks for the streaming services and stores, in their own
// colours (not currentColor) so the service reads at a glance. One source for
// the context menus' Open-in / Search-in rows and the feed cards' source
// strip — add a provider here and both surfaces pick it up.

const mark = (body: string): string => `<svg class="ctx-brand" width="13" height="13" viewBox="0 0 24 24">${body}</svg>`;

export const BRAND_ICONS: Readonly<Record<string, string>> = {
	spotify: mark('<circle cx="12" cy="12" r="11" fill="#1DB954"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M6.3 9.4c3.7-1.2 8.2-.9 11.5 1" stroke-width="2.1"/><path d="M7 12.8c3-.9 6.6-.6 9.3.9" stroke-width="1.8"/><path d="M7.8 15.9c2.3-.6 4.8-.4 6.9.7" stroke-width="1.5"/></g>'),
	tidal: mark('<g fill="#efeff2"><path d="M6 5l3.4 3.4L6 11.8 2.6 8.4z"/><path d="M12 5l3.4 3.4L12 11.8 8.6 8.4z"/><path d="M18 5l3.4 3.4L18 11.8l-3.4-3.4z"/><path d="M12 11.6l3.4 3.4-3.4 3.4-3.4-3.4z"/></g>'),
	beatport: mark('<rect x="1" y="1" width="22" height="22" rx="6" fill="#01FF95"/><path d="M8.5 5v13" stroke="#000" stroke-width="2.4" stroke-linecap="round"/><circle cx="12.6" cy="14" r="3.9" fill="none" stroke="#000" stroke-width="2.4"/>'),
	beatsource: mark('<rect x="1" y="1" width="22" height="22" rx="6" fill="#FF7A00"/><path d="M8.5 5v13" stroke="#000" stroke-width="2.4" stroke-linecap="round"/><circle cx="12.6" cy="14" r="3.9" fill="none" stroke="#000" stroke-width="2.4"/>'),
	traxsource: mark('<rect x="1" y="1" width="22" height="22" rx="6" fill="#0C3C64"/><path d="M6.5 7h11M12 7v11" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>'),
	bandcamp: mark('<rect x="1" y="1" width="22" height="22" rx="6" fill="#629AA9"/><path d="M4.5 16.5h9.5l5.5-9H10z" fill="#fff"/>'),
	soundcloud: mark('<circle cx="12" cy="12" r="11" fill="#FF5500"/><g fill="#fff"><rect x="4.5" y="12" width="1.8" height="5" rx=".9"/><rect x="7.5" y="10.5" width="1.8" height="6.5" rx=".9"/><rect x="10.5" y="9" width="1.8" height="8" rx=".9"/><path d="M13.8 9.6a3.4 3.4 0 0 1 5.9 2.3h.3a2.5 2.5 0 0 1 0 5h-6.2z"/></g>'),
	youtube: mark('<rect x="1" y="4" width="22" height="16" rx="5" fill="#FF0000"/><path d="M10 8.5v7l6-3.5z" fill="#fff"/>'),
	deezer: mark('<rect x="1" y="1" width="22" height="22" rx="6" fill="#121216"/><g fill="#A238FF"><rect x="4" y="15" width="4" height="2"/><rect x="4" y="12" width="4" height="2"/><rect x="10" y="15" width="4" height="2"/><rect x="10" y="12" width="4" height="2"/><rect x="10" y="9" width="4" height="2"/><rect x="16" y="15" width="4" height="2"/><rect x="16" y="12" width="4" height="2"/><rect x="16" y="9" width="4" height="2"/><rect x="16" y="6" width="4" height="2"/></g>'),
	apple: mark('<rect x="1" y="1" width="22" height="22" rx="6" fill="#FA243C"/><path d="M15.8 5.2v9.3a2.4 2.4 0 1 1-1.6-2.3V8.5l-4.4 1.1v6.6a2.4 2.4 0 1 1-1.6-2.3V7.1z" fill="#fff"/>'),
};

// Display order for a row of marks: players first, then stores in the order
// a DJ shops (feedHandles STORE_ORDER), then the rest.
export const BRAND_ORDER: readonly string[] = ['spotify', 'tidal', 'beatport', 'bandcamp', 'traxsource', 'soundcloud', 'youtube', 'deezer', 'apple', 'beatsource'];

export const brandIcon = (provider: string): string | undefined => BRAND_ICONS[provider];
