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

// Formats a timestamp like Go's time.Time default String() output,
// e.g. "2026-08-27 06:05:46 +0000 UTC" — matches the bridge's own format.
function formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000 UTC`;
}

// Rules are stored as a flat array: [{ phone_number, name, timestamp }, ...]
// Old-format files (an object keyed by phone_number) are normalized into
// this array shape on load, so existing rules.json files keep working.
function loadRules() {
    if (!fs.existsSync(RULES_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
    if (Array.isArray(raw)) return raw;

    return Object.entries(raw).map(([phone_number, value]) => {
        if (typeof value === 'string') {
            return { phone_number, name: value, timestamp: formatTimestamp(new Date(0)) };
        }
        return { phone_number, name: value.name, timestamp: value.timestamp || formatTimestamp(new Date(0)) };
    });
}
function saveRules(rules) {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}
function findRule(rules, phone_number) {
    return rules.find(r => r.phone_number === phone_number);
}
// Replaces any existing entry for phone_number and puts the new one first,
// so the array itself stays newest-first without needing a re-sort.
function upsertRule(rules, phone_number, name, timestamp) {
    const rest = rules.filter(r => r.phone_number !== phone_number);
    return [{ phone_number, name, timestamp }, ...rest];
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
        .map(m => ({ ...m, name: (m.phone_number && findRule(rules, m.phone_number)?.name) || null }));
    return c.json(pending);
});

app.get('/api/approved', (c) => {
    const status = loadStatus();
    const rules = loadRules();
    const all = getMediaMessages();
    const approved = all
        .filter(m => status[m.id] === 'approved')
        .map(m => ({ ...m, name: (m.phone_number && findRule(rules, m.phone_number)?.name) || null }))
        .slice(0, 100);
    return c.json(approved);
});

// Single-message actions kept for compatibility (e.g. per-row Reject)
app.post('/api/approve', (c) => {
    const id = c.req.query('id');
    if (!id) return c.json({ ok: false, error: 'id query param is required' }, 400);

    // Find the media message
    const message = db.prepare(`
        SELECT id, phone_number
        FROM messages
        WHERE id = ?
        LIMIT 1
    `).get(id);

    if (!message) {
        return c.json({
            ok: false,
            error: 'Media message not found'
        }, 404);
    }

    const phoneNumber = message.phone_number;

    const rules = loadRules(); // Check whether this number already has a rule
    const rule = phoneNumber ? findRule(rules, phoneNumber) : null;

    // No rule for this number -> tell frontend to open name picker
    if (!rule) {
        return c.json({
            ok: false,
            needsName: true,
            id,
            phone_number: phoneNumber
        });
    }

    // Rule exists -> approve ONLY this media
    saveStatus(markStatus(id, 'approved'));

    return c.json({
        ok: true,
        id,
        phone_number: phoneNumber,
        name: rule.name
    });
});

app.post('/api/reject', (c) => {
    const id = c.req.query('id');
    if (!id) return c.json({ ok: false, error: 'id query param is required' }, 400);
    saveStatus(markStatus(id, 'rejected'));
    return c.json({ ok: true });
});

app.get('/api/names', (c) => {
    const rules = loadRules();
    const names = [...new Set(rules.map(r => r.name))].sort();
    return c.json(names);
});

// Wrapped response, sorted newest-first by timestamp.
app.get('/api/rules', (c) => {
    const rules = loadRules();
    const results = [...rules].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return c.json({ success: true, data: { results } });
});

// Bulk-approve every pending message for a phone_number, and remember the name
// against that number so future approvals for it skip the picker.
app.post('/api/approve-group', (c) => {
    const phone_number = c.req.query('phone_number');
    const name = c.req.query('name');
    if (!phone_number) return c.json({ ok: false, error: 'phone_number is required' }, 400);

    let rules = loadRules();
    const finalName = name || findRule(rules, phone_number)?.name;
    if (!finalName) return c.json({ ok: false, error: 'name is required (no existing rule for this number)' }, 400);

    rules = upsertRule(rules, phone_number, finalName, formatTimestamp());
    saveRules(rules);

    const status = loadStatus();
    const all = getMediaMessages();
    const ids = all
        .filter(m => m.phone_number === phone_number && !status[m.id])
        .map(m => m.id);
    markManyStatus(ids, 'approved');

    return c.json({ ok: true, name: finalName, approved: ids.length });
});

// Rename the client/lead attached to a phone_number (rules.html "Edit name")
app.post('/api/rules/rename', (c) => {
    const phone_number = c.req.query('phone_number');
    const name = c.req.query('name');
    if (!phone_number || !name) return c.json({ ok: false, error: 'phone_number and name are required' }, 400);
    let rules = loadRules();
    rules = upsertRule(rules, phone_number, name, formatTimestamp());
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