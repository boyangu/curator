// BYOK agent config custody. The API key is safeStorage-encrypted (bound to
// the OS user account) and persisted to userData/agent-config.json beside
// the DBs — deliberately NOT in curator.db: a copied DB must never carry a
// usable secret (CLAUDE.md's token-rows lesson), and a copied config file is
// inert off this machine. The decrypted key exists only in main-process
// memory on its way into the sidecar's configure RPC; the renderer only ever
// sees hasKey.

import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, AgentProvider } from '@curator/core';
import type { AgentConfigInput, AgentConfigRedacted } from '../ipc.js';
import { mainLog } from './log.js';

const clog = mainLog.for('agent-config');

interface StoredAgentConfig {
	provider: AgentProvider;
	baseUrl?: string;
	routerModel: string;
	researchModel: string;
	// base64 of safeStorage.encryptString(apiKey).
	apiKeyEnc?: string;
}

function configPath(): string {
	return join(app.getPath('userData'), 'agent-config.json');
}

function readStored(): StoredAgentConfig | null {
	const path = configPath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as StoredAgentConfig;
	} catch (err) {
		clog.warn('unreadable agent-config.json — treating as unconfigured', undefined, err);
		return null;
	}
}

function decryptKey(stored: StoredAgentConfig): string | null {
	if (!stored.apiKeyEnc) return null;
	try {
		return safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, 'base64'));
	} catch (err) {
		// Wrong OS account / reinstalled machine — the key is gone, the rest
		// of the config survives; the panel shows the re-enter-key state.
		clog.warn('stored API key failed to decrypt — key must be re-entered', undefined, err);
		return null;
	}
}

// Full config with the live key — main-process consumption only (boot
// configure + set-config). Null when no usable key exists.
export function loadAgentConfig(): AgentConfig | null {
	const stored = readStored();
	if (!stored) return null;
	const apiKey = decryptKey(stored);
	if (!apiKey) return null;
	return {
		provider: stored.provider,
		...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
		apiKey,
		routerModel: stored.routerModel,
		researchModel: stored.researchModel,
	};
}

export function getRedactedAgentConfig(): AgentConfigRedacted | null {
	const stored = readStored();
	if (!stored) return null;
	return {
		provider: stored.provider,
		...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
		routerModel: stored.routerModel,
		researchModel: stored.researchModel,
		hasKey: !!stored.apiKeyEnc && decryptKey(stored) !== null,
	};
}

// Persist an update from the settings UI. `apiKey` absent keeps the stored
// key (model/provider changes without re-typing the secret). Returns the
// full config when a usable key exists — the caller forwards it to
// svc.configureAgent — or null when still keyless.
export function saveAgentConfig(input: AgentConfigInput): AgentConfig | null {
	const prev = readStored();
	const stored: StoredAgentConfig = {
		provider: input.provider,
		...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
		routerModel: input.routerModel,
		researchModel: input.researchModel,
	};
	if (input.apiKey && input.apiKey.trim().length > 0) {
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error('OS credential encryption is unavailable — cannot store the API key');
		}
		stored.apiKeyEnc = safeStorage.encryptString(input.apiKey.trim()).toString('base64');
	} else if (prev?.apiKeyEnc) {
		stored.apiKeyEnc = prev.apiKeyEnc;
	}
	writeFileSync(configPath(), JSON.stringify(stored, null, '\t'), 'utf8');
	return loadAgentConfig();
}
