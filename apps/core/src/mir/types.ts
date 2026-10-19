// Public shapes of the AI audio analysis engine layer (apps/mir + this module).
// The engine itself is a Python sidecar; everything here is what CoreService
// exposes over IPC/agent tools, so treat it as part of the public contract.

import type { ZTrackFilterT } from '@curator/shared';

export type MirExecutor = 'local' | 'cloud';

// User-facing settings, persisted in curator.db app_setting (core-owned, so
// dev and packaged builds can't drift the way per-origin localStorage did).
export interface MirSettings {
	// Background embedding of the playable (local-file) library.
	enabled: boolean;
	// 'local' = this machine (Intel XPU/CUDA when present, else CPU);
	// 'cloud' = Modal GPU batches (audio is uploaded; see apps/mir/README.md).
	executor: MirExecutor;
	// Models to compute, in priority order. The first is the default model
	// for similarity queries.
	models: string[];
}

// Default models = the Phase 0 bake-off winner (research/mir/FINDINGS.md):
// MERT-v2 + MuQ-MuLan blended beat every single model on the user's own tags
// and DJ-set adjacency; MuQ-MuLan also brings text search.
export const DEFAULT_MIR_SETTINGS: MirSettings = {
	enabled: false,
	executor: 'local',
	models: ['mert-v2-fullsong', 'muq-mulan-large'],
};

export interface MirModelInfo {
	key: string;
	modelId: string; // "<key>@<adapter version>" — what vectors are keyed by
	dim: number;
	sampleRate: number;
	text: boolean; // text prompts embed into the same space (text search)
	license: string;
	repo: string;
	summary: string;
}

export type MirState = 'disabled' | 'starting' | 'ready' | 'unavailable';

export interface MirModelCoverage {
	done: number;
	failed: number;
}

export interface MirStatus {
	state: MirState;
	reason: string | null;
	device: string | null;
	cloudConfigured: boolean;
	settings: MirSettings;
	models: MirModelInfo[];
	coverage: {
		// Local tracks with a file — the population the engine can analyze.
		localTracks: number;
		perModel: Record<string, MirModelCoverage>;
	};
	running: string | null; // track id being analyzed
	pending: number; // tracks still to analyze for the enabled models
	sessionDone: number;
	lastError: string | null;
	// Packaged builds set the engine env up on demand (see mir/provision.ts).
	provisionable: boolean; // a Set up action is available (env missing)
	provisioning: boolean;
	provisionLog: string | null; // last line of uv output / the failure
}

export interface SimilarQuery {
	// Seed tracks (multi-seed = centroid of their normalised vectors). Either
	// seeds or text is required.
	seeds?: string[];
	// Free-text query; needs a text-capable model (MuQ-MuLan / CLAP).
	text?: string;
	// Model key; default = first enabled model (for text: first enabled
	// text-capable model).
	model?: string;
	k?: number; // default 50, max 500
	// Restrict candidates to tracks matching this library filter (SQL pushdown).
	filter?: ZTrackFilterT;
	excludeSeeds?: boolean; // default true
}

export interface SimilarTrack {
	trackId: string;
	score: number; // cosine similarity, -1..1
}

export interface SimilarResult {
	model: string | null; // modelId used, null when nothing could be ranked
	items: SimilarTrack[];
	// Seeds that had no vector for the model (e.g. streaming-only tracks).
	missingSeeds: string[];
}

export type MirEvent =
	| { kind: 'status'; status: MirStatus }
	| { kind: 'analyzed'; trackId: string; modelIds: string[] }
	| { kind: 'failed'; trackId: string; modelId: string; errorKind: string; message: string };

export const MIR_K_MAX = 500;
export const MIR_K_DEFAULT = 50;
