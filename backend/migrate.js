// Applies backend/migrations/*.sql in filename order to DATABASE_URL.
// Applied files are tracked in public.schema_migrations, so re-running is safe.
// Intended for a fresh database; the original Supabase project already has 001-007.
//
//   node migrate.js            apply pending migrations
//   node migrate.js --status   list applied/pending without changing anything

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function main() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('DATABASE_URL is not set');
        process.exit(1);
    }
    const statusOnly = process.argv.includes('--status');

    const client = new Client({ connectionString });
    await client.connect();
    try {
        // Supabase keeps extensions in their own schema and the migrations reference it.
        await client.query('create schema if not exists extensions');
        await client.query('set search_path to public, extensions');
        await client.query(`
            create table if not exists public.schema_migrations (
                name text primary key,
                applied_at timestamptz not null default now()
            )`);

        const { rows } = await client.query('select name from public.schema_migrations');
        const applied = new Set(rows.map(r => r.name));
        const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

        for (const file of files) {
            if (applied.has(file)) {
                console.log(`applied  ${file}`);
                continue;
            }
            if (statusOnly) {
                console.log(`pending  ${file}`);
                continue;
            }
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
            await client.query('begin');
            try {
                await client.query(sql);
                await client.query('insert into public.schema_migrations (name) values ($1)', [file]);
                await client.query('commit');
                console.log(`applying ${file} ... ok`);
            } catch (error) {
                await client.query('rollback');
                console.error(`applying ${file} ... FAILED: ${error.message}`);
                process.exitCode = 1;
                return;
            }
        }

        if (!statusOnly) {
            // Every future session: extensions schema resolvable (vector operators), UTC timestamps.
            await client.query(`do $$ begin
                execute format('alter database %I set search_path to public, extensions', current_database());
                execute format('alter database %I set timezone to %L', current_database(), 'UTC');
            end $$`);
        }
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error('migrate failed:', error.message);
    process.exit(1);
});
