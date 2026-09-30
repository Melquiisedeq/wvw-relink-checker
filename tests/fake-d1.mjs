// The D1 binding the Worker uses - prepare, bind, run, all, first - over an
// in-memory node:sqlite database built from worker/*.sql in order. D1 is SQLite,
// so the SQL itself is what these tests exercise; D1's own limits and its
// network are not. node:sqlite needs Node 22.13 or later with no flag.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const WORKER = new URL('../worker/', import.meta.url);

export function fakeD1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:');
  // schema.sql, then schema-002-*.sql and on: the order they were run in the
  // D1 console. Named, not just sorted: '-' sorts before '.'.
  const files = ['schema.sql',
    ...readdirSync(WORKER).filter((f) => /^schema-\d+-.*\.sql$/.test(f)).sort()];
  for (const f of files) if (!skip.includes(f)) sql.exec(readFileSync(new URL(f, WORKER), 'utf8'));

  // Every statement the Worker ran, with its arguments, so a test can ask
  // SQLite how it was executed.
  const ran = [];
  class Statement {
    constructor(q) { this.q = q; this.args = []; }
    bind(...args) { this.args = args; ran.push(this); return this; }
    async run() {
      const r = sql.prepare(this.q).run(...this.args);
      return { meta: { changes: Number(r.changes) } };
    }
    async all() { return { results: sql.prepare(this.q).all(...this.args) }; }
    async first() { return sql.prepare(this.q).get(...this.args) ?? null; }
  }
  return { sql, ran, DB: { prepare: (q) => new Statement(q) } };
}
