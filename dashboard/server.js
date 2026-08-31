import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';

const MESSAGES_DB_PATH = process.env.MESSAGES_DB_PATH || '/app/store/messages.db';
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8080';
const STATUS_FILE = './status.json';

// Open messages.db READ-ONLY — never write to the bridge's own database
const db = new DatabaseSync(MESSAGES_DB_PATH, { readOnly: true });

// Load or create the local status tracker (approved/rejected message IDs)
function loadStatus() {
    if (!fs.existsSync(STATUS_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
}
function saveStatus(status) {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

const app = new Hono();

function getMediaMessages() {
    return db.prepare(`
    SELECT id, chat_jid, phone_number, filename, media_type, timestamp
    FROM messages
    WHERE media_type IN ('image', 'document')
      AND filename != ''
      AND is_from_me = 0
    ORDER BY timestamp DESC
  `).all();
}

function markStatus(id, value) {
    const status = loadStatus();
    delete status[id]; // in case it's being re-approved/re-rejected, drop the old position
    const updated = { [id]: value, ...status };
    saveStatus(updated);
}

app.get('/api/all-media', (c) => {
    const status = loadStatus();
    const all = getMediaMessages();
    const pending = all.filter(m => !status[m.id]);
    return c.json(pending);
});

app.get('/api/approved', (c) => {
    const status = loadStatus();
    const all = getMediaMessages();
    const approved = all
        .filter(m => status[m.id] === 'approved')
        .slice(0, 100); // last 100 only
    return c.json(approved);
});

app.post('/api/approve', (c) => {
    const id = c.req.query('id');
    if (!id) return c.json({ ok: false, error: 'id query param is required' }, 400);
    markStatus(id, 'approved');
    return c.json({ ok: true });
});

app.post('/api/reject', (c) => {
    const id = c.req.query('id');
    if (!id) return c.json({ ok: false, error: 'id query param is required' }, 400);
    markStatus(id, 'rejected');
    return c.json({ ok: true });
});

app.get('/api/status', async (c) => {
    try { return c.json(await (await fetch(`${BRIDGE_URL}/api/status`)).json()); }
    catch { return c.json({ connected: false }); }
});
app.get('/api/qr', async (c) => {
    try { return c.json(await (await fetch(`${BRIDGE_URL}/api/qr`)).json()); }
    catch { return c.json({ qr: '' }); }
});
app.post('/api/login', async (c) => {
    try { await fetch(`${BRIDGE_URL}/api/login`, { method: 'POST' }); } catch { }
    return c.json({ ok: true });
});

app.use('/*', serveStatic({ root: './public' }));

serve({ fetch: app.fetch, port: 4000 }, (info) => {
    console.log(`Dashboard running at http://localhost:${info.port}`);
});