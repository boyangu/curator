// The Spotify/Tidal tokens' seal at rest (core's TokenSealer, auth/store.ts):
// safeStorage, as the Curator session (cloud/account.ts), the Drive refresh
// token and the agent's API key already are. The key is this OS user's, held
// by the OS credential store, so curator.db on its own, or a copy of it on
// another machine, carries no usable token.
//
// Only after app 'ready' (safeStorage's rule); createCoreService runs there.

import { safeStorage } from 'electron';
import type { TokenSealer } from '@curator/core';
import { mainLog } from './log.js';

// Undefined when the OS offers no credential encryption (a Linux session
// without a keyring): core then stores the tokens in plaintext, as it did
// before sealing, and this says so once.
export function createTokenSealer(): TokenSealer | undefined {
	if (!safeStorage.isEncryptionAvailable()) {
		mainLog.for('auth').warn('OS credential encryption is unavailable: Spotify/Tidal tokens are stored unsealed');
		return undefined;
	}
	return {
		seal: (plain) => safeStorage.encryptString(plain).toString('base64'),
		open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
	};
}
