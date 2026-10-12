import { parseArgs } from 'node:util';
import { sourceOf } from '../shared/stats.ts';
import { deleteReplays, listSummaries } from '../server/store.ts';

/**
 * Look after saved replays, here (data/) or on a hosted site (--remote, with ADMIN_TOKEN).
 *
 *   npm run replays -- list [--source community] [--remote https://...]
 *   npm run replays -- delete <id> [<id>...] [--remote https://...]
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { remote: { type: 'string' }, source: { type: 'string' } },
});
const [command, ...ids] = positionals;
const remote = values.remote?.replace(/\/+$/, '');
const token = process.env.ADMIN_TOKEN ?? '';
if (remote && command === 'delete' && !token) {
  console.error('Deleting on a hosted site needs ADMIN_TOKEN (the one set on the site).');
  process.exit(1);
}

type Row = { id: string; source: string; createdAt: string; left: string; right: string };

async function list(): Promise<Row[]> {
  if (!remote) return (await listSummaries()).map((s) => ({ ...s, source: sourceOf(s) }));
  const res = await fetch(`${remote}/api/replays?source=${values.source ?? 'all'}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { replays: Row[] }).replays;
}

async function remove(id: string): Promise<boolean> {
  if (!remote) return (await deleteReplays([id])).length > 0;
  const res = await fetch(`${remote}/api/replays/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return true;
}

if (command === 'list') {
  const rows = (await list()).filter((r) => !values.source || values.source === 'all' || r.source === values.source).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const r of rows) console.log(`${r.id}  ${r.source.padEnd(9)}  ${r.createdAt.slice(0, 16)}  ${r.left} vs ${r.right}`);
  console.log(`${rows.length} replay(s)${remote ? ` on ${remote}` : ''}`);
} else if (command === 'delete' && ids.length) {
  for (const id of ids) console.log(`${id}: ${(await remove(id)) ? 'deleted' : 'not found'}`);
} else {
  console.error('Usage: npm run replays -- list [--source official|community] [--remote URL]\n       npm run replays -- delete <id>... [--remote URL]');
  process.exit(1);
}
