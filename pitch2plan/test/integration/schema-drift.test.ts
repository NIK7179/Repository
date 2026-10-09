import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';

/**
 * The migrations are hand-written SQL. This test fails if they ever disagree with schema.prisma
 * about which tables/columns exist or whether a column is nullable, enum-typed or an array.
 */
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const ready = client.connect();
afterAll(async () => { await ready; await client.end(); });

describe('migrations match schema.prisma', () => {
  it('has the same tables, columns and nullability', async () => {
    await ready;
    const { rows } = await client.query<{ table_name: string; column_name: string; is_nullable: string; data_type: string }>(
      `SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const db = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
    const problems: string[] = [];
    const models = parseSchema(readFileSync(new URL('../../packages/db/prisma/schema.prisma', import.meta.url), 'utf8'));
    expect(models.length).toBeGreaterThan(20);
    for (const m of models) {
      for (const f of m.fields) {
        const col = db.get(`${m.name}.${f.name}`);
        if (!col) { problems.push(`missing column ${m.name}.${f.name}`); continue; }
        if ((col.is_nullable === 'YES') !== f.optional) problems.push(`nullability differs for ${m.name}.${f.name}`);
        if (f.isEnum && col.data_type !== 'USER-DEFINED') problems.push(`${m.name}.${f.name} should be an enum`);
        if (f.type === 'Json' && col.data_type !== 'jsonb') problems.push(`${m.name}.${f.name} should be jsonb`);
        if (f.type === 'Int' && col.data_type !== 'integer') problems.push(`${m.name}.${f.name} should be integer`);
        if (f.type === 'Float' && col.data_type !== 'double precision') problems.push(`${m.name}.${f.name} should be double precision`);
        if (f.type === 'Boolean' && col.data_type !== 'boolean') problems.push(`${m.name}.${f.name} should be boolean`);
        if (f.type === 'DateTime' && !col.data_type.startsWith('timestamp')) problems.push(`${m.name}.${f.name} should be a timestamp`);
        if (f.type === 'String' && f.uuid && col.data_type !== 'uuid') problems.push(`${m.name}.${f.name} should be uuid`);
        if (f.type === 'String' && !f.uuid && !f.isEnum && col.data_type !== 'text') problems.push(`${m.name}.${f.name} should be text`);
      }
    }
    const modelTables = new Set(models.map((m) => m.name));
    for (const key of db.keys()) { const t = key.split('.')[0]!; if (t !== '_sql_migrations' && !modelTables.has(t)) problems.push(`table ${t} is not in schema.prisma`); }
    expect(problems).toEqual([]);
  });
});

interface Field { name: string; type: string; optional: boolean; uuid: boolean; isEnum: boolean }
/** Minimal schema.prisma reader: scalar and enum columns only (relations and lists are not columns). */
function parseSchema(src: string): Array<{ name: string; fields: Field[] }> {
  const enums = new Set([...src.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]!));
  const modelNames = new Set([...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!));
  const scalars = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json']);
  return [...src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => ({
    name: m[1]!,
    fields: m[2]!.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
      .map((l) => /^(\w+)\s+(\w+)(\?|\[\])?/.exec(l)).filter((x): x is RegExpExecArray => !!x)
      .filter((x) => x[3] !== '[]' && !modelNames.has(x[2]!) && (scalars.has(x[2]!) || enums.has(x[2]!)))
      .map((x) => ({ name: x[1]!, type: x[2]!, optional: x[3] === '?', uuid: /@db\.Uuid/.test(x.input), isEnum: enums.has(x[2]!) })),
  }));
}
