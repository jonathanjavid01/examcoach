#!/usr/bin/env node
/**
 * ExamCoach backend — zero-dependency Node server.
 *
 * Endpoints
 *   GET  /api/health            -> { ok, aiConfigured, model }
 *   POST /api/grade             -> AI IELTS writing grade (Gemini) with a
 *                                  verification second pass. Body:
 *                                  { taskType, prompt, essay, email? }
 *                                  Free limit: 2/day per IP without email,
 *                                  10/day with a captured email.
 *   POST /api/subscribe         -> email capture. Body: { email, targetBand?, examDate?, source? }
 *   GET  /api/leads?token=...   -> CSV of captured leads (requires ADMIN_TOKEN env)
 *   GET  /*                     -> serves the static site from ../ (index.html)
 *
 * Environment
 *   GEMINI_API_KEY   (or GOOGLE_API_KEY)  — get a free-tier key in Google AI Studio.
 *                                            The key stays on the server; never put it in the web page.
 *   GEMINI_MODEL     default "gemini-3.5-flash" (check AI Studio for the current free-tier model)
 *   LLM_BASE_URL     default "https://generativelanguage.googleapis.com" (override only for testing)
 *   ADMIN_TOKEN      long random string; enables /api/leads CSV download
 *   PORT             default 8787
 *   DAILY_GRADE_CAP  default 200 — hard daily cap on AI grades (cost guard)
 *   DATA_DIR         default ./data  (leads.jsonl + usage.jsonl are appended there)
 *
 * Run:  GEMINI_API_KEY=... ADMIN_TOKEN=... node examcoach-server.mjs
 */
import http from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(HERE, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(HERE, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DAILY_CAP = parseInt(process.env.DAILY_GRADE_CAP || '200', 10);
const FREE_PER_DAY = 2, EMAIL_PER_DAY = 10;

const dayKey = () => new Date().toISOString().slice(0, 10);
const ipHash = (req) => crypto.createHash('sha256').update(String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).digest('hex').slice(0, 16);
const usageFile = path.join(DATA_DIR, 'usage.jsonl');
const leadsFile = path.join(DATA_DIR, 'leads.jsonl');
const logUsage = (rec) => { try { appendFileSync(usageFile, JSON.stringify({ d: dayKey(), ...rec }) + '\n'); } catch {} };
function countToday(filter) {
  if (!existsSync(usageFile)) return 0;
  return readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((r) => r.d === dayKey() && filter(r)).length;
}

const SYSTEM = `You are an IELTS Writing examiner-assessor. Score ONLY against the official public band descriptors for the four criteria. Return JSON only, in exactly this shape: {"task_response": <0-9 in 0.5 steps>, "coherence_cohesion": <0-9 in 0.5 steps>, "lexical_resource": <0-9 in 0.5 steps>, "grammatical_range_accuracy": <0-9 in 0.5 steps>, "evidence": {"task_response": "<short quote from the essay>", "coherence_cohesion": "<short quote>", "lexical_resource": "<short quote>", "grammatical_range_accuracy": "<short quote>"}, "top_mistakes": [{"quote": "...", "problem": "...", "fix": "..."}, {"quote": "...", "problem": "...", "fix": "..."}, {"quote": "...", "problem": "...", "fix": "..."}], "rewritten_paragraph": "<the candidate's first body paragraph rewritten at Band 7.5, preserving their ideas>", "one_next_action": "<the single most valuable next practice action>"}. Rules: (1) If the answer is under the minimum word count (Task 2: 250, Task 1: 150), cap Task Response/Achievement at 5.0 and say so in a mistake. (2) Quote the candidate's own words as evidence for every criterion; do not invent errors that are not in the text. (3) Penalise memorised/template language under Coherence and Lexical Resource. (4) Use 'Task Achievement' wording in evidence for Task 1 and 'Task Response' for Task 2. (5) CALIBRATION ANCHORS (apply strictly): Band 9 is expert, near-native and rare. Award 9.0 in any criterion only when the writing is virtually error-free AND fully sophisticated. Any recurring error pattern caps that criterion at 8.0 or below. Most competent university-level candidates score 6.0 to 7.5 overall. A strong, well organised essay with a few non-impeding errors is Band 7.0 to 7.5, NOT 8.5 to 9.0. Lexical Resource 8.0 or above requires precise, less common collocations used naturally throughout, not a handful of advanced words. Grammatical Range 8.0 or above requires a wide range of complex structures with only rare slips. Before finalising each criterion, ask whether a strict examiner comparing this script with real Band 7 and Band 8 scripts would place it there. If in doubt, choose the lower half-band.`;

async function callGemini(userText) {
  const url = `${LLM_BASE}/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: SYSTEM + '\n\n' + userText }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 8192 },
    }),
  });
  if (!res.ok) throw new Error('llm_http_' + res.status);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('') || '';
  const usage = data?.usageMetadata || null;
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  return { json: JSON.parse(text.slice(a, b + 1)), usage };
}
const clampBand = (x) => Math.max(0, Math.min(9, Math.round((Number(x) || 0) * 2) / 2));
function normalise(g) {
  return {
    task_response: clampBand(g.task_response), coherence_cohesion: clampBand(g.coherence_cohesion),
    lexical_resource: clampBand(g.lexical_resource), grammatical_range_accuracy: clampBand(g.grammatical_range_accuracy),
    evidence: g.evidence || {}, top_mistakes: Array.isArray(g.top_mistakes) ? g.top_mistakes.slice(0, 3) : [],
    rewritten_paragraph: String(g.rewritten_paragraph || ''), one_next_action: String(g.one_next_action || ''),
  };
}

function send(res, code, obj, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(obj) : String(obj);
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(body);
}
const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 200_000) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad_json')); } });
  req.on('error', reject);
});
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (u.pathname === '/api/health') return send(res, 200, { ok: true, aiConfigured: Boolean(API_KEY), model: MODEL, gradesToday: countToday((r) => r.kind === 'grade') });

    if (u.pathname === '/api/subscribe' && req.method === 'POST') {
      const b = await readBody(req);
      if (!validEmail(b.email)) return send(res, 400, { error: 'invalid_email' });
      const rec = { d: dayKey(), ts: new Date().toISOString(), email: String(b.email).trim().toLowerCase(), targetBand: b.targetBand || null, examDate: b.examDate || null, source: String(b.source || 'checker').slice(0, 40) };
      appendFileSync(leadsFile, JSON.stringify(rec) + '\n');
      logUsage({ kind: 'subscribe', ip: ipHash(req) });
      return send(res, 200, { ok: true });
    }

    if (u.pathname === '/api/leads' && req.method === 'GET') {
      if (!ADMIN_TOKEN || u.searchParams.get('token') !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' });
      const rows = existsSync(leadsFile) ? readFileSync(leadsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const csv = 'date,email,target_band,exam_date,source\n' + rows.map((r) => [r.d, r.email, r.targetBand || '', r.examDate || '', r.source || ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      return send(res, 200, csv, 'text/csv');
    }

    if (u.pathname === '/api/grade' && req.method === 'POST') {
      if (!API_KEY) return send(res, 503, { error: 'ai_not_configured' });
      if (countToday((r) => r.kind === 'grade') >= DAILY_CAP) return send(res, 503, { error: 'daily_cap_reached' });
      const b = await readBody(req);
      const essay = String(b.essay || '');
      if (essay.trim().length < 200 || essay.length > 12000) return send(res, 400, { error: 'essay_length' });
      const ip = ipHash(req);
      const limit = validEmail(b.email) ? EMAIL_PER_DAY : FREE_PER_DAY;
      if (countToday((r) => r.kind === 'grade' && r.ip === ip) >= limit) return send(res, 429, { error: 'free_limit', limit });
      const taskLabel = b.taskType === '1a' ? 'Task 1 Academic' : b.taskType === '1g' ? 'Task 1 General Training' : 'Task 2';
      const user = `Task type: ${taskLabel}. Prompt: ${String(b.prompt || '(not provided)').slice(0, 600)}\nEssay:\n${essay}`;
      const pass1 = normalise((await callGemini(user)).json);
      logUsage({ kind: 'llm_call', ip, pass: 1 });
      let final = pass1, passes = 1;
      try {
        const verify = `Verify each score in this assessment against the public band descriptors and each quoted error against the essay text. Correct any score the evidence does not support. Return the corrected assessment as JSON in exactly the same shape.\nAssessment: ${JSON.stringify(pass1)}\nEssay:\n${essay}`;
        const pass2 = normalise((await callGemini(verify)).json);
        logUsage({ kind: 'llm_call', ip, pass: 2 });
        const avg = (a, c) => clampBand((a + c) / 2);
        final = { ...pass2, task_response: avg(pass1.task_response, pass2.task_response), coherence_cohesion: avg(pass1.coherence_cohesion, pass2.coherence_cohesion), lexical_resource: avg(pass1.lexical_resource, pass2.lexical_resource), grammatical_range_accuracy: avg(pass1.grammatical_range_accuracy, pass2.grammatical_range_accuracy) };
        passes = 2;
      } catch { /* second pass is best-effort; pass 1 stands */ }
      const overall = clampBand((final.task_response + final.coherence_cohesion + final.lexical_resource + final.grammatical_range_accuracy) / 4);
      logUsage({ kind: 'grade', ip, overall });
      return send(res, 200, { source: 'ai', model: MODEL, passes, overall, ...final });
    }

    if (u.pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found' });

    // static site
    let rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const file = path.join(SITE_DIR, rel);
    if (!file.startsWith(SITE_DIR) || !existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    return send(res, 500, { error: 'server_error', detail: String(e.message || e).slice(0, 120) });
  }
});
server.listen(PORT, () => console.log(`ExamCoach server on :${PORT} — AI configured: ${Boolean(API_KEY)} — model: ${MODEL}`));
