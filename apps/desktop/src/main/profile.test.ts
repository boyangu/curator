import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	ALLOW_REKORDBOX_ENV,
	decideRails,
	parseProfileEnv,
	profileAppUserModelId,
	profileDeviceName,
	profileDownloadDirs,
	profileRailsSummary,
	profileTitleSuffix,
	profileUserDataDir,
} from './profile.js';

// Absolute on whatever OS runs the suite; the shape is what matters.
const DEFAULT_UD = resolve('roaming', 'Curator');
const SECOND_UD = profileUserDataDir(DEFAULT_UD, 'second');

describe('parseProfileEnv', () => {
	it('treats unset and empty as the normal app', () => {
		expect(parseProfileEnv(undefined)).toEqual({ kind: 'default' });
		expect(parseProfileEnv('')).toEqual({ kind: 'default' });
	});

	it('accepts lower-case letters, digits and dashes up to 32 chars', () => {
		for (const name of ['second', 'a', 'desk-2', '0', 'x'.repeat(32)]) {
			expect(parseProfileEnv(name)).toEqual({ kind: 'profile', name });
		}
	});

	it('rejects everything else instead of falling back to the default library', () => {
		for (const raw of ['Second', 'x'.repeat(33), 'a b', 'a_b', '../curator', 'a/b', 'a\\b', ' second', 'second ', '.', 'é']) {
			expect(parseProfileEnv(raw)).toEqual({ kind: 'invalid', raw });
		}
	});
});

describe('profileUserDataDir', () => {
	it('derives a sibling of the default userData', () => {
		expect(SECOND_UD).toBe(`${DEFAULT_UD}-second`);
	});

	it('ignores a trailing separator', () => {
		expect(profileUserDataDir(`${DEFAULT_UD}\\`, 'second')).toBe(`${DEFAULT_UD}-second`);
		expect(profileUserDataDir('/home/g/.config/Curator/', 'x')).toBe('/home/g/.config/Curator-x');
	});
});

describe('decideRails — default app', () => {
	it('changes nothing when no profile is set, whatever the env says', () => {
		const rails = decideRails(null, { [ALLOW_REKORDBOX_ENV]: '1', CURATOR_DB_URL: 'x.db' }, null);
		expect(rails).toEqual({
			profile: null, rekordbox: true, remoteWrites: true, backup: true, dbUrlOverride: true, downloadsBlocked: null, overrides: [],
		});
		expect(profileTitleSuffix(rails)).toBe('');
	});
});

describe('decideRails — profile', () => {
	it('closes every rail by default', () => {
		const rails = decideRails('second', {}, SECOND_UD);
		expect(rails.profile).toBe('second');
		expect(rails.rekordbox).toBe(false);
		expect(rails.remoteWrites).toBe(false);
		expect(rails.backup).toBe(false);
		expect(rails.dbUrlOverride).toBe(false);
		expect(rails.downloadsBlocked).toMatch(/Downloads are off/);
		expect(rails.overrides).toEqual([]);
	});

	it('opens rekordbox only for the exact override value, and names it', () => {
		expect(decideRails('second', { [ALLOW_REKORDBOX_ENV]: 'true' }, SECOND_UD).rekordbox).toBe(false);
		const rails = decideRails('second', { [ALLOW_REKORDBOX_ENV]: '1' }, SECOND_UD);
		expect(rails.rekordbox).toBe(true);
		expect(rails.overrides).toEqual([`${ALLOW_REKORDBOX_ENV}=1`]);
		expect(profileTitleSuffix(rails)).toBe(` — profile: second [${ALLOW_REKORDBOX_ENV}=1]`);
	});

	it('has no override for remote writes, backup or the DB path', () => {
		const env = {
			[ALLOW_REKORDBOX_ENV]: '1',
			CURATOR_PROFILE_ALLOW_REMOTE_WRITES: '1',
			CURATOR_PROFILE_ALLOW_BACKUP: '1',
			CURATOR_DB_URL: join(DEFAULT_UD, 'curator.db'),
		};
		const rails = decideRails('second', env, SECOND_UD);
		expect(rails.remoteWrites).toBe(false);
		expect(rails.backup).toBe(false);
		expect(rails.dbUrlOverride).toBe(false);
	});

	it('allows downloads only when both folders were redirected into the profile', () => {
		const inside = profileDownloadDirs(SECOND_UD);
		expect(decideRails('second', inside, SECOND_UD).downloadsBlocked).toBeNull();
		// One redirected is not enough — redownloads would still hit ~/Music.
		expect(decideRails('second', { CURATOR_DOWNLOAD_DIR: inside.CURATOR_DOWNLOAD_DIR }, SECOND_UD).downloadsBlocked).not.toBeNull();
		// The real library's folder, the real userData, and a lookalike prefix.
		for (const dir of [resolve('music', 'Curator'), join(DEFAULT_UD, 'downloads'), `${SECOND_UD}x`, SECOND_UD, join(SECOND_UD, '..', 'Curator', 'dl')]) {
			const env = { ...inside, CURATOR_DOWNLOAD_DIR: dir };
			expect(decideRails('second', env, SECOND_UD).downloadsBlocked, dir).not.toBeNull();
		}
	});

	it('summarises every rail in one record', () => {
		const summary = profileRailsSummary(decideRails('second', {}, SECOND_UD), SECOND_UD);
		expect(summary).toMatchObject({ profile: 'second', userData: SECOND_UD });
		expect(summary['rekordbox']).toMatch(/^off/);
		expect(summary['remoteWrites']).toMatch(/^off/);
		expect(summary['backup']).toMatch(/^off/);
		expect(summary['downloads']).toMatch(/^blocked/);
		expect(summary['dbUrlOverride']).toBe('ignored');
	});
});

describe('identity helpers', () => {
	it('keeps the default ids untouched and suffixes profile ones', () => {
		expect(profileAppUserModelId('com.curator.app', null)).toBe('com.curator.app');
		expect(profileAppUserModelId('com.curator.app', 'second')).toBe('com.curator.app.profile.second');
		expect(profileDeviceName('GUY-PC', null)).toBe('GUY-PC');
		expect(profileDeviceName('GUY-PC', 'second')).toBe('GUY-PC (profile: second)');
	});
});
