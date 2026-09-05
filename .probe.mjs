import { sign } from 'hono/jwt';
import fs from 'fs';
const secret = fs.readFileSync('.dev.vars', 'utf8')
  .split('\n').find(l => l.startsWith('JWT_SECRET=')).split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
const now = Math.floor(Date.now()/1000);
const tok = await sign({ userId: process.argv[2], username: process.argv[3], type: 'access', iat: now, exp: now + 600 }, secret, 'HS256');
const B = 'https://abs-shim.jderrick.app';
for (const [label, path] of [
  ['storage/status', '/api/admin/storage/status'],
  ['abb/settings', '/api/admin/abb/settings'],
  ['abb/torrents', '/api/admin/abb/torrents'],
]) {
  const res = await fetch(B + path, { headers: { Authorization: 'Bearer ' + tok } });
  const body = await res.text();
  let short;
  if (label === 'storage/status') {
    try { const d = JSON.parse(body); short = JSON.stringify({ role: d.role, canAdd: d.canAdd, membersCanAdd: d.membersCanAdd }); } catch { short = body.slice(0,200); }
  } else if (label === 'abb/torrents') {
    try { const d = JSON.parse(body); short = d.torrents ? 'torrents: ' + d.torrents.length : body.slice(0,200); } catch { short = body.slice(0,200); }
  } else short = body.slice(0, 220);
  console.log(label, res.status, short);
}
