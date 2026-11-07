// Direct Postgres access with a PostgREST-compatible request API.
//
// The world service was written against Supabase's REST layer (PostgREST). This module
// executes the same requests ({ method, query, body, prefer }) as SQL over a pg pool, so
// any Postgres with the migrations applied works — no Supabase/PostgREST in between.
// Only the PostgREST subset the backend actually uses is supported; anything else throws
// instead of being silently ignored. New code should prefer raw SQL via query()/transaction().

const { Pool, types } = require('pg');

const IDENT = /^[a-z_][a-z0-9_]*$/;
const RESERVED_QUERY_KEYS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const COMPARISON_OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

// Match PostgREST's JSON output on Supabase: int8/numeric as numbers, timestamptz as UTC
// ISO-8601 with full microsecond precision (values are fed back into gt./lte. filters and
// compared as strings), regardless of the server's TimeZone setting.
const TIMESTAMPTZ = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d)(?::?(\d\d))?(?::?(\d\d))?$/;
function toUtcIsoTimestamp(value) {
    const m = TIMESTAMPTZ.exec(value);
    if (!m) return value; // infinity, BC dates: pass through untouched
    const [, date, time, fraction = '', offH, offM = '00', offS = '00'] = m;
    const utc = new Date(`${date}T${time}Z`);
    const sign = offH.startsWith('-') ? -1 : 1;
    const offsetSeconds = sign * (Math.abs(Number(offH)) * 3600 + Number(offM) * 60 + Number(offS));
    utc.setTime(utc.getTime() - offsetSeconds * 1000);
    return `${utc.toISOString().slice(0, 19)}${fraction}+00:00`;
}
const int8ArrayParser = types.getTypeParser(1016);
const TYPE_PARSERS = {
    20: Number, // int8
    1700: Number, // numeric
    1016: (value) => int8ArrayParser(value).map(v => (v === null ? null : Number(v))), // int8[]
    1082: (value) => value, // date
    1114: (value) => value.replace(' ', 'T'), // timestamp
    1184: toUtcIsoTimestamp // timestamptz
};
const getTypeParser = (oid, format) => TYPE_PARSERS[oid] || types.getTypeParser(oid, format);

function quoteIdent(name) {
    if (!IDENT.test(String(name))) throw new Error(`unsupported identifier: ${name}`);
    return `"${name}"`;
}

// Split on commas that are not inside parentheses or double quotes.
function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let quoted = false;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && quoted && i + 1 < text.length) {
            current += ch + text[++i];
            continue;
        }
        if (ch === '"') quoted = !quoted;
        else if (!quoted && ch === '(') depth++;
        else if (!quoted && ch === ')') depth--;
        if (ch === ',' && depth === 0 && !quoted) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current) parts.push(current);
    return parts.map(p => p.trim()).filter(Boolean);
}

function unquote(value) {
    const v = String(value).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
        return v.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    return v;
}

function parseInList(raw) {
    const text = String(raw).trim();
    if (!text.startsWith('(') || !text.endsWith(')')) throw new Error(`malformed in-list: ${raw}`);
    return splitTopLevel(text.slice(1, -1)).map(unquote);
}

function parsePrefer(prefer) {
    const flags = {};
    for (const part of String(prefer || '').split(',')) {
        const [key, value] = part.split('=').map(s => s && s.trim());
        if (key) flags[key] = value || true;
    }
    return flags;
}

class PgRest {
    constructor() {
        this.pool = null;
        this.columns = new Map(); // table -> Map(column -> sql type)
        this.primaryKeys = new Map(); // table -> [column]
        this.functions = new Map(); // name -> { returnsSet, args: Map(name -> sql type) }
    }

    async connect(connectionString, { max = 10 } = {}) {
        // search_path (pgvector lives in the "extensions" schema, as on Supabase) and the UTC
        // time zone are database-level settings applied by migrate.js.
        this.pool = new Pool({ connectionString, max, types: { getTypeParser } });
        this.pool.on('error', (error) => {
            console.error('Postgres pool error:', error.message);
        });
        await this.loadCatalog();
    }

    async close() {
        if (this.pool) await this.pool.end();
        this.pool = null;
    }

    async loadCatalog() {
        const [columnsRes, keysRes, functionsRes] = await Promise.all([
            this.pool.query(`
                select c.relname as table_name, a.attname as column_name,
                       format_type(a.atttypid, a.atttypmod) as sql_type
                from pg_attribute a
                join pg_class c on c.oid = a.attrelid
                join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('r', 'v', 'p')
                  and a.attnum > 0 and not a.attisdropped`),
            this.pool.query(`
                select c.relname as table_name, array_agg(a.attname::text order by k.ord) as columns
                from pg_index i
                join pg_class c on c.oid = i.indrelid
                join pg_namespace n on n.oid = c.relnamespace
                cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
                where n.nspname = 'public' and i.indisprimary
                group by c.relname`),
            this.pool.query(`
                select p.proname as name, p.proretset as returns_set,
                       coalesce(p.proargnames, '{}') as arg_names,
                       coalesce(p.proargmodes::text[], '{}') as arg_modes,
                       array(select format_type(t, null) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) as t) as arg_types
                from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prokind = 'f'`)
        ]);

        this.columns.clear();
        for (const row of columnsRes.rows) {
            if (!this.columns.has(row.table_name)) this.columns.set(row.table_name, new Map());
            this.columns.get(row.table_name).set(row.column_name, row.sql_type);
        }
        this.primaryKeys.clear();
        for (const row of keysRes.rows) this.primaryKeys.set(row.table_name, row.columns);
        this.functions.clear();
        for (const row of functionsRes.rows) {
            const args = new Map();
            row.arg_names.forEach((name, idx) => {
                const mode = row.arg_modes[idx] || 'i';
                if (name && (mode === 'i' || mode === 'b')) args.set(name, row.arg_types[idx]);
            });
            this.functions.set(row.name, { returnsSet: row.returns_set, args });
        }
    }

    async query(text, params = []) {
        return this.pool.query(text, params);
    }

    async transaction(fn) {
        const client = await this.pool.connect();
        try {
            await client.query('begin');
            const result = await fn(client);
            await client.query('commit');
            return result;
        } catch (error) {
            await client.query('rollback').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    // Same contract as the old Supabase restRequest: never throws, returns { data, error, status, count }.
    async request(path, { method = 'GET', query = {}, body, prefer = null } = {}) {
        try {
            const { text, values, shape } = this.buildStatement(path, { method, query: query || {}, body, prefer });
            if (!text) return { data: shape === 'rows' ? [] : null, error: null, status: 200, count: 0 };
            const result = await this.pool.query(text, values);
            if (shape === 'count') return { data: null, error: null, status: 200, count: Number(result.rows[0]?.count || 0) };
            if (shape === 'scalar') return { data: result.rows[0]?.result ?? null, error: null, status: 200, count: null };
            if (shape === 'rows') return { data: result.rows, error: null, status: 200, count: result.rowCount };
            return { data: null, error: null, status: 204, count: result.rowCount };
        } catch (error) {
            return {
                data: null,
                error: {
                    message: error?.message || String(error),
                    details: { code: error?.code || null, detail: error?.detail || null, hint: error?.hint || null }
                },
                status: error?.code ? 400 : 500,
                count: null
            };
        }
    }

    buildStatement(path, { method, query, body, prefer }) {
        const flags = parsePrefer(prefer);
        const params = [];
        const bind = (value, sqlType) => {
            params.push(this.serialize(value, sqlType));
            return `$${params.length}::${sqlType}`;
        };

        if (path.startsWith('rpc/')) {
            return this.buildRpc(path.slice(4), body || {}, params, bind);
        }

        const table = path;
        const tableColumns = this.columns.get(table);
        if (!tableColumns) throw new Error(`unknown table: ${table}`);
        const columnType = (column) => {
            const sqlType = tableColumns.get(column);
            if (!sqlType) throw new Error(`unknown column: ${table}.${column}`);
            return sqlType;
        };
        const from = `public.${quoteIdent(table)}`;
        const selectList = this.buildSelect(query.select, columnType);

        if (method === 'POST') {
            const rows = (Array.isArray(body) ? body : [body]).filter(row => row && typeof row === 'object');
            if (!rows.length) return { text: null, values: [], shape: 'rows' };

            const columns = [];
            for (const row of rows) {
                for (const [key, value] of Object.entries(row)) {
                    if (value !== undefined && !columns.includes(key)) columns.push(key);
                }
            }
            const tuples = rows.map(row => `(${columns.map(column => (
                row[column] === undefined ? 'default' : bind(row[column], columnType(column))
            )).join(', ')})`);

            let text = `insert into ${from} (${columns.map(quoteIdent).join(', ')}) values ${tuples.join(', ')}`;
            const resolution = flags.resolution;
            if (resolution === 'merge-duplicates' || resolution === 'ignore-duplicates') {
                const target = query.on_conflict
                    ? String(query.on_conflict).split(',').map(s => s.trim())
                    : (this.primaryKeys.get(table) || []);
                if (!target.length) throw new Error(`no conflict target for ${table}`);
                text += ` on conflict (${target.map(quoteIdent).join(', ')})`;
                text += resolution === 'merge-duplicates'
                    ? ` do update set ${columns.map(c => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', ')}`
                    : ' do nothing';
            }
            if (flags.return === 'representation') {
                return { text: `${text} returning ${selectList}`, values: params, shape: 'rows' };
            }
            return { text, values: params, shape: 'none' };
        }

        if (method === 'PATCH') {
            const entries = Object.entries(body || {}).filter(([, value]) => value !== undefined);
            if (!entries.length) return { text: null, values: [], shape: 'none' };
            const setList = entries.map(([column, value]) => `${quoteIdent(column)} = ${bind(value, columnType(column))}`);
            const text = `update ${from} set ${setList.join(', ')}${this.buildWhere(query, columnType, bind)}`;
            if (flags.return === 'representation') {
                return { text: `${text} returning ${selectList}`, values: params, shape: 'rows' };
            }
            return { text, values: params, shape: 'none' };
        }

        const where = this.buildWhere(query, columnType, bind);

        if (method === 'GET') {
            let text = `select ${selectList} from ${from}${where}`;
            text += this.buildOrder(query.order, columnType);
            text += this.buildLimit(query);
            return { text, values: params, shape: 'rows' };
        }

        if (method === 'HEAD') {
            if (flags.count !== 'exact') throw new Error('HEAD is only supported with Prefer: count=exact');
            return { text: `select count(*) as count from ${from}${where}`, values: params, shape: 'count' };
        }

        if (method === 'DELETE') {
            const text = `delete from ${from}${where}`;
            if (flags.return === 'representation') {
                return { text: `${text} returning ${selectList}`, values: params, shape: 'rows' };
            }
            return { text, values: params, shape: 'none' };
        }

        throw new Error(`unsupported method: ${method}`);
    }

    buildRpc(name, body, params, bind) {
        const fn = this.functions.get(name);
        if (!fn) throw new Error(`unknown function: ${name}`);
        const args = [];
        for (const [argName, value] of Object.entries(body)) {
            if (value === undefined) continue;
            const sqlType = fn.args.get(argName);
            if (!sqlType) throw new Error(`unknown argument ${argName} for ${name}`);
            args.push(`${quoteIdent(argName)} => ${bind(value, sqlType)}`);
        }
        const call = `public.${quoteIdent(name)}(${args.join(', ')})`;
        return fn.returnsSet
            ? { text: `select * from ${call}`, values: params, shape: 'rows' }
            : { text: `select ${call} as result`, values: params, shape: 'scalar' };
    }

    buildSelect(select, columnType) {
        const raw = String(select || '*').trim();
        if (raw === '*') return '*';
        return raw.split(',').map(s => s.trim()).filter(Boolean).map((column) => {
            columnType(column);
            return quoteIdent(column);
        }).join(', ');
    }

    buildWhere(query, columnType, bind) {
        const conditions = [];
        for (const [key, raw] of Object.entries(query)) {
            if (RESERVED_QUERY_KEYS.has(key) || raw === undefined || raw === null || raw === '') continue;
            if (key === 'or' || key === 'and') {
                const text = String(raw).trim();
                if (!text.startsWith('(') || !text.endsWith(')')) throw new Error(`malformed ${key}: ${raw}`);
                const parts = splitTopLevel(text.slice(1, -1)).map((part) => {
                    const dot = part.indexOf('.');
                    if (dot <= 0) throw new Error(`malformed ${key} condition: ${part}`);
                    return this.buildCondition(part.slice(0, dot), part.slice(dot + 1), columnType, bind);
                });
                if (parts.length) conditions.push(`(${parts.join(` ${key} `)})`);
                continue;
            }
            conditions.push(this.buildCondition(key, String(raw), columnType, bind));
        }
        return conditions.length ? ` where ${conditions.join(' and ')}` : '';
    }

    buildCondition(column, expression, columnType, bind) {
        let expr = expression;
        let negate = false;
        if (expr.startsWith('not.')) {
            negate = true;
            expr = expr.slice(4);
        }
        const dot = expr.indexOf('.');
        if (dot <= 0) throw new Error(`malformed filter ${column}=${expression}`);
        const op = expr.slice(0, dot);
        const value = expr.slice(dot + 1);
        const sqlType = columnType(column);
        const col = quoteIdent(column);

        let condition;
        if (COMPARISON_OPS[op]) {
            condition = `${col} ${COMPARISON_OPS[op]} ${bind(value, sqlType)}`;
        } else if (op === 'in') {
            condition = `${col} = any(${bind(parseInList(value), `${sqlType}[]`)})`;
        } else if (op === 'is') {
            const keyword = { null: 'null', true: 'true', false: 'false', unknown: 'unknown' }[value.toLowerCase()];
            if (!keyword) throw new Error(`unsupported is.${value}`);
            condition = `${col} is ${keyword}`;
        } else {
            throw new Error(`unsupported filter operator: ${op}`);
        }
        return negate ? `not (${condition})` : condition;
    }

    buildOrder(order, columnType) {
        if (!order) return '';
        const terms = String(order).split(',').map(s => s.trim()).filter(Boolean).map((term) => {
            const [column, ...modifiers] = term.split('.');
            columnType(column);
            let sql = quoteIdent(column);
            for (const modifier of modifiers) {
                if (modifier === 'asc') sql += ' asc';
                else if (modifier === 'desc') sql += ' desc';
                else if (modifier === 'nullsfirst') sql += ' nulls first';
                else if (modifier === 'nullslast') sql += ' nulls last';
                else throw new Error(`unsupported order modifier: ${modifier}`);
            }
            return sql;
        });
        return terms.length ? ` order by ${terms.join(', ')}` : '';
    }

    buildLimit(query) {
        let sql = '';
        if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
            const limit = Number(query.limit);
            if (!Number.isInteger(limit) || limit < 0) throw new Error(`invalid limit: ${query.limit}`);
            sql += ` limit ${limit}`;
        }
        if (query.offset !== undefined && query.offset !== null && query.offset !== '') {
            const offset = Number(query.offset);
            if (!Number.isInteger(offset) || offset < 0) throw new Error(`invalid offset: ${query.offset}`);
            sql += ` offset ${offset}`;
        }
        return sql;
    }

    // Convert a JSON value (as PostgREST would receive it) into a pg parameter for sqlType.
    serialize(value, sqlType) {
        if (value === null || value === undefined) return null;
        if (sqlType === 'json' || sqlType === 'jsonb') return JSON.stringify(value);
        if (/^(extensions\.)?vector\b/.test(sqlType) && Array.isArray(value)) return `[${value.join(',')}]`;
        if (Array.isArray(value)) return value;
        if (value instanceof Date) return value.toISOString();
        if (typeof value === 'object') return JSON.stringify(value);
        return value;
    }
}

module.exports = { PgRest };
