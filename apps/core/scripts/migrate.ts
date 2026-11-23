// `pnpm db:migrate`: migrate a library database in place.
import { migrate } from '@curator/sync-core/db/migrate';
import { log } from '@curator/sync-core/log';

const mlog = log.for('migrate');
const dbPath = process.env.CURATOR_DB_URL ?? './curator.db';
mlog.info('migrating', { dbPath });
migrate(dbPath);
mlog.info('done');
