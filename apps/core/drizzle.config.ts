import type { Config } from 'drizzle-kit';

export default {
	schema: '../../packages/shared/src/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: process.env.CURATOR_DB_URL ?? './curator.db',
	},
} satisfies Config;
