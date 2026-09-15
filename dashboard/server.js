import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const MESSAGES_DB_PATH = process.env.MESSAGES_DB_PATH || '/app/store/messages.db';
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8080';
const STATUS_FILE = process.env.STATUS_FILE || './status.json';
const RULES_FILE = process.env.RULES_FILE || './rules.json';
const UNLINKED_KEY = '__unlinked__';
const STORE_DIR = path.dirname(MESSAGES_DB_PATH); // e.g. /app/store — same folder the bridge downloads media into
const EXPORT_ROOT = process.env.EXPORT_ROOT || './export';

// Open messages.db READ-ONLY — never write to the bridge's own database
const db = new DatabaseSync(MESSAGES_DB_PATH, { readOnly: true });

function statusKey(phoneNumber) {
    return phoneNumber || UNLINKED_KEY;
}

function loadStatus() {
    if (!fs.existsSync(STATUS_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));

    const alreadyMigrated = Object.values(raw).every(v => v && typeof v === 'object' && Array.isArray(v.media));
    if (alreadyMigrated) return raw;

    const migrated = {};
    for (const [id, value] of Object.entries(raw)) {
        const entry = typeof value === 'string'
            ? { status: value, at: formatTimestamp(new Date(0)) }
            : { status: value.status, at: value.at || formatTimestamp(new Date(0)) };

        const message = db.prepare('SELECT phone_number FROM messages WHERE id = ? LIMIT 1').get(id);
        const key = statusKey(message?.phone_number);

        if (!migrated[key]) migrated[key] = { media: [] };
        migrated[key].media.push({ id, ...entry });
    }
    return migrated;
}

function saveStatus(status) {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

function findStatusEntry(status, phoneNumber, id) {
    const key = statusKey(phoneNumber);
    return status[key]?.media.find(m => m.id === id) || null;
}

// Loads, updates, and returns status (caller saves it) — mirrors the old
// markStatus contract so call sites stay a one-liner.
function markStatus(phoneNumber, id, value) {
    const status = loadStatus();
    const key = statusKey(phoneNumber);
    if (!status[key]) status[key] = { media: [] };
    status[key].media = status[key].media.filter(m => m.id !== id);
    status[key].media.unshift({ id, status: value, at: formatTimestamp() });
    return status;
}

function markManyStatus(phoneNumber, ids, value) {
    const status = loadStatus();
    const key = statusKey(phoneNumber);
    if (!status[key]) status[key] = { media: [] };
    const at = formatTimestamp();
    status[key].media = status[key].media.filter(m => !ids.includes(m.id));
    status[key].media.unshift(...ids.map(id => ({ id, status: value, at })));
    saveStatus(status);
}

// Formats a timestamp like Go's time.Time default String() output,
// e.g. "2026-08-27 06:05:46 +0000 UTC" — matches the bridge's own format.
function formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000 UTC`;
}

// Copies an already-downloaded media file into <EXPORT_ROOT>/<rule_name>/<phone_number>/<filename>.
// Silently skips if the source file hasn't been downloaded by the bridge yet.
function exportApprovedMedia(phoneNumber, filename, ruleName) {
    if (!phoneNumber || !filename || !ruleName) return;
    try {
        const src = path.join(STORE_DIR, phoneNumber, filename);
        if (!fs.existsSync(src)) return;
        const destDir = path.join(EXPORT_ROOT, ruleName, phoneNumber);
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, path.join(destDir, filename));
    } catch (err) {
        console.error('exportApprovedMedia failed:', err);
    }
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
        .filter(m => !findStatusEntry(status, m.phone_number, m.id))
        .map(m => ({ ...m, name: (m.phone_number && findRule(rules, m.phone_number)?.name) || null }));
    return c.json(pending);
});

app.get('/api/approved-media', (c) => {
    const status = loadStatus();
    const rules = loadRules();
    const all = getMediaMessages();
    const byId = new Map(all.map(m => [m.id, m]));

    const results = Object.entries(status)
        .filter(([key]) => key !== UNLINKED_KEY || true) // unlinked included too
        .map(([phone_number, group]) => {
            const media = group.media
                .filter(entry => entry.status === 'approved' && byId.has(entry.id))
                .map(entry => {
                    const m = byId.get(entry.id);
                    return { ...m, approvedAt: entry.at };
                });

            return {
                phone_number: phone_number === UNLINKED_KEY ? null : phone_number,
                name: (phone_number !== UNLINKED_KEY && findRule(rules, phone_number)?.name) || null,
                latestApprovedAt: media[0]?.at,
                media
            };
        })
        .filter(group => group.media.length > 0)
        .sort((a, b) => b.media[0].approvedAt.localeCompare(a.media[0].approvedAt))
        .slice(0, 100);

    return c.json({ success: true, data: { results } });
});

// Single-message actions kept for compatibility (e.g. per-row Reject)
app.post('/api/approve', (c) => {
    const id = c.req.query('id');
    if (!id) return c.json({ ok: false, error: 'id query param is required' }, 400);

    // Find the media message
    const message = db.prepare(`
        SELECT id, phone_number, filename
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
    saveStatus(markStatus(phoneNumber, id, 'approved'));
    exportApprovedMedia(phoneNumber, message.filename, rule.name);

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

    const message = db.prepare('SELECT id, phone_number FROM messages WHERE id = ? LIMIT 1').get(id);
    if (!message) return c.json({ ok: false, error: 'Media message not found' }, 404);

    saveStatus(markStatus(message.phone_number, id, 'rejected'));
    return c.json({ ok: true });
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
    const toApprove = all.filter(m => m.phone_number === phone_number && !findStatusEntry(status, phone_number, m.id));
    const ids = toApprove.map(m => m.id);
    markManyStatus(phone_number, ids, 'approved');
    toApprove.forEach(m => exportApprovedMedia(phone_number, m.filename, finalName));

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