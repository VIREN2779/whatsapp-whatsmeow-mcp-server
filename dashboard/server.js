// server.js
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';

const MESSAGES_DB_PATH = process.env.MESSAGES_DB_PATH || '/root/workspace/whatsameow/whatsapp-bridge/store/messages.db';
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8080';
const STATUS_FILE = './status.json';
const RULES_FILE = './rules.json';

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
function markStatus(id, value) {
    const status = loadStatus();
    delete status[id];
    return { [id]: value, ...status };
}
function markManyStatus(ids, value) {
    let status = loadStatus();
    for (const id of ids) {
        delete status[id];
        status = { [id]: value, ...status };
    }
    saveStatus(status);
}

function loadRules() {
    if (!fs.existsSync(RULES_FILE)) return {};
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
}
function saveRules(rules) {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
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

app.get('/api/all-media', (c) => {
    const status = loadStatus();
    const rules = loadRules();
    const all = getMediaMessages();
    const pending = all
        .filter(m => !status[m.id])
        .map(m => ({ ...m, name: (m.phone_number && rules[m.phone_number]) || null }));
    return c.json(pending);
});

app.get('/api/approved', (c) => {
    const status = loadStatus();
    const rules = loadRules();
    const all = getMediaMessages();
    const approved = all
        .filter(m => status[m.id] === 'approved')
        .map(m => ({ ...m, name: (m.phone_number && rules[m.phone_number]) || null }))
        .slice(0, 100);
    return c.json(approved);
});

// Single-message actions kept for compatibility (e.g. per-row Reject)
app.post('/api/approve', (c) => {
    const id = c.req.query('id');
    if (!id) return c.json({ ok: false, error: 'id query param is required' }, 400);
    saveStatus(markStatus(id, 'approved'));
    return c.json({ ok: true });
});

app.post('/api/reject', (c) => {
    const id = c.req.query('id');
    if (!id) return c.json({ ok: false, error: 'id query param is required' }, 400);
    saveStatus(markStatus(id, 'rejected'));
    return c.json({ ok: true });
});

app.get('/api/names', (c) => {
    const rules = loadRules();
    const names = [...new Set(Object.values(rules))].sort();
    return c.json(names);
});

app.get('/api/rules', (c) => {
    const rules = loadRules();
    const rows = Object.entries(rules)
        .map(([phone_number, name]) => ({ phone_number, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return c.json(rows);
});

// Bulk-approve every pending message for a phone_number, and remember the name
// against that number so future approvals for it skip the picker.
app.post('/api/approve-group', (c) => {
    const phone_number = c.req.query('phone_number');
    const name = c.req.query('name');
    if (!phone_number) return c.json({ ok: false, error: 'phone_number is required' }, 400);

    const rules = loadRules();
    const finalName = name || rules[phone_number];
    if (!finalName) return c.json({ ok: false, error: 'name is required (no existing rule for this number)' }, 400);

    rules[phone_number] = finalName;
    saveRules(rules);

    const status = loadStatus();
    const all = getMediaMessages();
    const ids = all
        .filter(m => m.phone_number === phone_number && !status[m.id])
        .map(m => m.id);
    markManyStatus(ids, 'approved');

    return c.json({ ok: true, name: finalName, approved: ids.length });
});

// Rename the client/lead attached to a phone_number (rules.html "Change name")
app.post('/api/rules/rename', (c) => {
    const phone_number = c.req.query('phone_number');
    const name = c.req.query('name');
    if (!phone_number || !name) return c.json({ ok: false, error: 'phone_number and name are required' }, 400);
    const rules = loadRules();
    rules[phone_number] = name;
    saveRules(rules);
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