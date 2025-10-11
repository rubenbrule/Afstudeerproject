import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import apiRoutes from './routes/api/index.js';
import { getPrompt } from './db/prompts.js';
import multer from 'multer';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPrompt, saveAssistantInfo, addPromptFiles } from './db/prompts.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', apiRoutes)

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3001;

function parsePrUrl(url) {
  const u = new URL(url);
  const [, owner, repo, , number] = u.pathname.split('/');
  if (!owner || !repo || !number) throw new Error('Ongeldige PR-URL');
  return { owner, repo, number: Number(number) };
}

function parseAddedLinesFromPatch(patch = "") {
  const added = new Set();
  if (!patch) return added;

  let newLine = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) {
      const m = l.match(/\+(\d+)(?:,(\d+))?/);
      if (m) newLine = parseInt(m[1], 10) - 1;
      continue;
    }
    if (l.startsWith(" ") || l.startsWith("+")) {
      newLine += 1;
      if (l.startsWith("+")) {
        added.add(newLine);
      }
    }
  }
  return added;
}

function groupAddedIntoSpans(addedSet) {
  const lines = Array.from(addedSet).sort((a, b) => a - b);
  const spans = [];
  let i = 0;
  while (i < lines.length) {
    let start = lines[i];
    let end = start;
    i++;
    while (i < lines.length && lines[i] === end + 1) {
      end = lines[i];
      i++;
    }
    spans.push([start, end]);
  }
  return spans;
}

function getPromptFileIds(promptRecord) {
  if (!promptRecord?.file_ids) return [];
  try { return JSON.parse(promptRecord.file_ids).map(x => x.id).filter(Boolean); }
  catch { return []; }
}

async function ensureAssistantAndStore(prompt) {
  const wantModel = process.env.OPENAI_ASSISTANT_MODEL || 'gpt-4o';

  if (prompt.assistant_id && prompt.vector_store_id) {
    try {
      const asst = await openai.beta.assistants.retrieve(prompt.assistant_id);

      const updates = {};

      // Model forceren
      if (asst.model !== wantModel) {
        updates.model = wantModel;
      }

      // file_search tool afdwingen
      const tools = Array.isArray(asst.tools) ? asst.tools : [];
      const hasFileSearch = tools.some(t => t?.type === 'file_search');
      if (!hasFileSearch) {
        updates.tools = [...tools, { type: 'file_search' }];
      }

      // vector store koppeling afdwingen
      const vsIds = asst?.tool_resources?.file_search?.vector_store_ids || [];
      if (!vsIds.includes(prompt.vector_store_id)) {
        updates.tool_resources = {
          file_search: { vector_store_ids: [prompt.vector_store_id] }
        };
      }

      if (Object.keys(updates).length > 0) {
        await openai.beta.assistants.update(prompt.assistant_id, updates);
        console.log('[ensure] assistant updated →', updates);
      }
    } catch (e) {
      console.log('[ensure] retrieve/update assistant failed', e?.message);
    }

    return {
      assistant_id: prompt.assistant_id,
      vector_store_id: prompt.vector_store_id,
    };
  }

  const store = await openai.vectorStores.create({
    name: `prompt-${prompt.id}-store`,
  });

  const assistant = await openai.beta.assistants.create({
    name: `Prompt ${prompt.title || prompt.id}`,
    instructions: prompt.content || 'Gebruik file search voor richtlijnen.',
    model: wantModel,
    tools: [{ type: 'file_search' }],
    tool_resources: { file_search: { vector_store_ids: [store.id] } },
  });

  await saveAssistantInfo(prompt.id, {
    assistant_id: assistant.id,
    vector_store_id: store.id,
  });

  console.log('[ensure] created assistant & store →', {
    assistant_id: assistant.id,
    vector_store_id: store.id,
  });

  return { assistant_id: assistant.id, vector_store_id: store.id };
}

// Upload bestanden → Files API → koppelen aan vector store (stable) + index poll
async function uploadFilesToVectorStore(vector_store_id, fileBlobs) {
  const uploads = [];
  const temps = [];
  try {
    for (const f of fileBlobs) {
      const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${Math.random().toString(36).slice(2)}-${f.originalname}`);
      await fs.writeFile(tmpPath, f.buffer);
      temps.push(tmpPath);

      const up = await openai.files.create({
        file: createReadStream(tmpPath),
        purpose: 'assistants',
      });
      uploads.push(up);
    }

    const out = [];
    for (const u of uploads) {
      const link = await openai.vectorStores.files.create(vector_store_id, { file_id: u.id });
      let linked = await openai.vectorStores.files.retrieve(vector_store_id, link.id);
      while (linked.status === 'queued' || linked.status === 'in_progress') {
        await new Promise(r => setTimeout(r, 1000));
        linked = await openai.vectorStores.files.retrieve(vector_store_id, link.id);
      }
      if (linked.status !== 'completed') throw new Error(`Indexing failed: ${u.filename || u.id} (${linked.status})`);
      out.push({ id: u.id, name: u.filename || u.id });
    }
    return out;
  } finally {
    await Promise.all(temps.map(p => fs.unlink(p).catch(() => {})));
  }
}

function buildReviewBlock(fileContent, addedSet, ctx = 3) {
  const out = [];
  const lines = fileContent.split("\n");
  const n = lines.length;

  const spans = groupAddedIntoSpans(addedSet);
  for (const [spanStart, spanEnd] of spans) {
    const from = Math.max(1, spanStart - ctx);
    const to = Math.min(n, spanEnd + ctx);
    for (let ln = from; ln <= to; ln++) {
      const mark = addedSet.has(ln) ? ">>" : "  ";
      const gutter = String(ln).padStart(4, " ");
      out.push(`${gutter} | ${mark} ${lines[ln - 1]}`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}

function decodeBase64(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

function oneLine(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u2028|\u2029/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

function changedHeadLinesFromPatch(patch = '') {
  const lines = patch.split('\n');
  const changed = new Set();
  let headLine = 0;

  for (const l of lines) {
    if (l.startsWith('@@')) {
      const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        headLine = Number(m[1]) - 1; 
      }
    } else if (l.startsWith(' ')) {
      headLine += 1; 
    } else if (l.startsWith('+')) {
      headLine += 1;        
      changed.add(headLine); 
    } else if (l.startsWith('-')) {
    }
  }
  return changed;
}


// --- helpers: compat voor assistants/vector stores + readiness check ---

async function ensureAssistantHasVectorStoreCompat(assistantId, vectorStoreId) {
  // gebruik nieuwe API als beschikbaar, anders beta.*
  const assistants = openai.assistants ?? openai.beta?.assistants;
  if (!assistants) throw new Error('OpenAI assistants API niet beschikbaar');

  const a = await assistants.retrieve(assistantId);

  // 1) file_search tool aanzetten indien nodig
  const tools = Array.isArray(a.tools) ? a.tools : [];
  const hasFileSearch = tools.some(t => t?.type === 'file_search');
  const update = {};
  if (!hasFileSearch) update.tools = [...tools, { type: 'file_search' }];

  // 2) vector store koppelen indien nodig
  const currentVS = a?.tool_resources?.file_search?.vector_store_ids || [];
  if (!currentVS.includes(vectorStoreId)) {
    update.tool_resources = {
      file_search: { vector_store_ids: [...currentVS, vectorStoreId] }
    };
  }

  if (Object.keys(update).length) {
    await assistants.update(assistantId, update);
  }
}

async function waitVectorStoreReadyCompat(vectorStoreId, { pollMs = 1200, timeoutMs = 60000 } = {}) {
  const vectorStores = openai.vectorStores ?? openai.beta?.vector_stores;
  if (!vectorStores) throw new Error('OpenAI vectorStores API niet beschikbaar');

  const t0 = Date.now();
  while (true) {
    // pagineer met limit 100 (max)
    let all = [];
    let after;
    do {
      const page = await vectorStores.files.list(vectorStoreId, { limit: 100, after });
      all = all.concat(page?.data || []);
      after = page?.last_id || undefined;
      if (!page?.has_more) break;
    } while (true);

    if (all.length === 0) return; // geen files = niets te wachten

    // status per file ophalen
    const statuses = [];
    for (const f of all) {
      try {
        const meta = await openai.files.retrieve(f.id);
        statuses.push(meta?.status || 'unknown');
      } catch {
        statuses.push('unknown');
      }
    }

    const inProgress = statuses.some(s => s === 'in_progress');
    const failed = statuses.some(s => s === 'failed');
    if (failed) throw new Error('Vector store indexing failed voor een of meer files');
    if (!inProgress) return; // alles klaar

    if (Date.now() - t0 > timeoutMs) throw new Error('Vector store indexing timeout');
    await new Promise(r => setTimeout(r, pollMs));
  }
}




app.post('/api/ai/review-pr', async (req, res) => {
  try {
    const { prUrl, promptId } = req.body;
    if (!prUrl) {
      return res.status(400).json({ ok: false, error: 'prUrl ontbreekt' });
    }

    // 1) Prompt record + tekst ophalen
    let selectedPromptText = null;
    let promptRecord = null;
    if (promptId) {
      try {
        promptRecord = await getPrompt(Number(promptId));
        if (promptRecord && typeof promptRecord.content === 'string' && promptRecord.content.trim()) {
          selectedPromptText = promptRecord.content;
        }
      } catch {}
    }

    const { prompt, headSha, changeMap } = await buildPromptFromPR(prUrl, selectedPromptText);

    let parsed = null;

    const fileIds = getPromptFileIds(promptRecord);
    const useAssistant = promptRecord?.assistant_id && fileIds.length > 0;

    if (useAssistant) {
      // Attachments voor file_search
      const attachments = fileIds.map((id) => ({
  file_id: id,
  tools: [{ type: 'file_search' }],
}));

const guard = `
BELANGRIJK (HARD):
- Lees en volg ALLE richtlijnen uit de bijgevoegde documenten (file search).
- Als in een document staat dat elke zin moet beginnen met "TESTEST", dan MOET elke 'suggestion' exact met "TESTEST " beginnen.
- Review ALLEEN regels met '>>' in de prompt. De rest is context.
- Output is ÉÉN JSON-object met de sleutel "findings" zoals gespecificeerd; GEEN proza buiten dat JSON.
`.trim();

// ✅ checks toevoegen (NIEUW)
  await ensureAssistantHasVectorStoreCompat(promptRecord.assistant_id, promptRecord.vector_store_id);
  await waitVectorStoreReadyCompat(promptRecord.vector_store_id);

// const thread = await openai.beta.threads.create({
//   messages: [
//     { role: 'user', content: `${prompt}\n\n${guard}`, attachments }
//   ],
// });

// try {
//   const msgs0 = await openai.beta.threads.messages.list(thread.id, { limit: 5 });
//   console.log('[thread first message attachments]',
//     (msgs0.data?.[0]?.attachments || []).map(a => ({ file_id: a.file_id, tools: a.tools?.map(t=>t.type) })));
// } catch (e) {
//   console.log('[thread attachments debug failed]', e?.message);
// }

// const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
//   assistant_id: promptRecord.assistant_id,
//   tool_choice: 'auto',
//   tool_resources: {
//     file_search: { vector_store_ids: [promptRecord.vector_store_id] }
//   },
// });

// if (run.status !== 'completed') {
//   try {
//     const steps = await openai.beta.threads.runs.steps.list(thread.id, run.id);
//     console.log('[assistant steps]', steps.data?.map(s => ({
//       type: s.type, status: s.status, tool: s.step_details?.type
//     })));
//   } catch {}
//   throw new Error(`Assistant run status: ${run.status}`);
// }
// Thread + eerste user message met attachments
const thread = await openai.beta.threads.create({
  messages: [
    { role: 'user', content: `${prompt}\n\n${guard}`, attachments }
  ],
});

// ▶️ Start run (zonder createAndPoll) zodat we zelf netjes kunnen loggen
let run = await openai.beta.threads.runs.create(thread.id, {
  assistant_id: promptRecord.assistant_id,
  // tool_choice mag 'auto' blijven; tool_resources koppelen we hier ook nog
  tool_choice: 'auto',
  tool_resources: {
    file_search: { vector_store_ids: [promptRecord.vector_store_id] }
  },
});

// 🔄 Poll expliciet en log status/last_error netjes
const startedAt = Date.now();
const POLL_MS = 1200;
const TIMEOUT_MS = 120000;

while (true) {
  run = await openai.beta.threads.runs.retrieve(thread.id, run.id);

  // optioneel: debug
  // console.log('[run status]', run.status, run.required_action || '');

  if (run.status === 'completed') break;

  if (run.status === 'requires_action') {
    // Voor file_search hoef je niets te doen (geen tool outputs vereist)
    // Andere tools (function calling) vereisen hier outputs. Zo niet → later fail.
    // console.warn('[requires_action]', JSON.stringify(run.required_action, null, 2));
  }

  if (['failed', 'expired', 'cancelled'].includes(run.status)) {
    console.error('[assistant run failed]', {
      status: run.status,
      last_error: run.last_error,
      usage: run.usage
    });
    throw new Error(`Assistant run status: ${run.status}${run.last_error?.message ? ' — ' + run.last_error.message : ''}`);
  }

  if (Date.now() - startedAt > TIMEOUT_MS) {
    throw new Error('Assistant run timeout');
  }

  await new Promise((r) => setTimeout(r, POLL_MS));
}

try {
  const steps = await openai.beta.threads.runs.steps.list(thread.id, run.id);
  console.log('[assistant steps]', steps.data?.map(s => ({
    type: s.type, status: s.status, tool: s.step_details?.type
  })));
} catch (e) {
  console.log('[assistant steps] couldn’t retrieve', e?.message);
}

const msgs = await openai.beta.threads.messages.list(thread.id, { limit: 50 });
const assistantTexts = msgs.data
  .filter(m => m.role === 'assistant')
  .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
  .map(m => (m.content || []).map(c => (c.type === 'text' ? c.text?.value : '')).join('\n'))
  .filter(Boolean);

const fullText = assistantTexts.join('\n').trim();

let jsonStr = fullText;
if (!/^\s*\{/.test(fullText)) {
  const m = fullText.match(/\{[\s\S]*\}$/);
  if (m) jsonStr = m[0];
}
parsed = tryJson(jsonStr);
    } else {
      const ai = await openai.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        input: prompt,
        text: {
          format: {
            type: 'json_schema',
            name: 'ReviewFindings',
            schema: {
              type: 'object',
              required: ['findings'],
              additionalProperties: false,
              properties: {
                findings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['file','start_line','end_line','severity','rule','message','suggestion'],
                    properties: {
                      file:       { type: 'string' },
                      start_line: { type: 'integer' },
                      end_line:   { type: 'integer' },
                      severity:   { type: 'string', enum: ['nit','suggestion','warning','error'] },
                      rule:       { type: 'string' },
                      message:    { type: 'string' },
                      suggestion: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      });

      parsed = ai.output_parsed;
      if (!parsed) {
        const raw = (ai.output_text ?? '').trim();
        parsed = tryJson(raw);
      }
    }

    const out = [];
    const changeKeys = Object.keys(changeMap || {});
    for (const it of (parsed?.findings || [])) {
      const file = it.file || it.path || it.filename;
      if (!file) continue;
      if (!changeMap[file]) {
        const base = String(file).replace(/\\/g, '/').split('/').pop();
        const cand = changeKeys.filter(k => k.endsWith('/' + base) || k === base);
        if (cand.length === 1) it.file = cand[0];
      }
      const resolved = it.file;
      const changed = changeMap[resolved];
      if (!changed || changed.size === 0) continue;

      let start = Number(it.start_line) || 0;
      let end   = Number(it.end_line)   || start;

      if (start <= 0 || end <= 0) {
        const firstChanged = Math.min(...changed);
        start = end = firstChanged;
      }

      let touches = false;
      for (let ln = start; ln <= end; ln++) {
        if (changed.has(ln)) { touches = true; break; }
      }
      if (!touches) {
        const changedLines = Array.from(changed).sort((a,b) => a - b);
        const target = start || end || changedLines[0];
        let best = changedLines[0], bestDiff = Math.abs(best - target);
        for (let i = 1; i < changedLines.length; i++) {
          const d = Math.abs(changedLines[i] - target);
          if (d < bestDiff) { best = changedLines[i]; bestDiff = d; }
        }
        start = end = best;
      }

      out.push({
        file: resolved,
        start_line: start,
        end_line: end,
        rule: it.rule || 'review',
        severity: it.severity || 'suggestion',
        message: it.message || '',
        suggestion: it.suggestion || ''
      });
    }

    return res.json({ headSha, findings: out });

  } catch (err) {
    console.error('AI review error:', err?.status, err?.message, err?.response?.data || err);
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || 'AI review gefaald',
      details: err?.response?.data || null
    });
  }
});

// async function buildPromptFromPR(prUrl, customHeader) {
//   const { owner, repo, number } = parsePrUrl(prUrl);

//   const pr = await octokit.pulls.get({ owner, repo, pull_number: number });
//   const headSha = pr.data.head.sha;

//   const filesRes = await octokit.pulls.listFiles({
//     owner, repo, pull_number: number, per_page: 100
//   });

//   let header = `
// Je bent een strikte code reviewer (HTML/CSS/JS/TS/React).

// TAAL:
// - Schrijf ALLE tekstuele velden (message, suggestion, rule) in het NEDERLANDS.
// - Gebruik beknopte, duidelijke Nederlandse formuleringen (geen Engels).
// - Voorbeelden van terminologie:
//   - "nit" -> gebruik "nit" of "kleine opmerking" (korte term is oké)
//   - "warning" -> "waarschuwing"
//   - "error" -> "fout"
//   - "prefer const" -> "gebruik bij voorkeur const"
// - Schrijf geen extra tekst buiten het JSON-object.

// SCOPE:
// - Analyseer ALLEEN gewijzigde regels in de PR (HEAD).
// - Beperk je tot concrete, actiegerichte feedback: wat is er mis, waarom, en hoe te fixen.

// OUTPUT:
// - Geef ALLEEN geldig JSON (geen uitleg buiten JSON) met exact dit schema:

// {
//   "findings": [
//     {
//       "file": "string",                     // pad zoals hieronder genoemd
//       "start_line": 0,                      // 1-based in HEAD
//       "end_line": 0,                        // 1-based in HEAD
//       "rule": "string (korte NL naam, bv. 'voorkeur const')",
//       "severity": "nit|suggestion|warning|error",
//       "message": "korte NL uitleg",
//       "suggestion": "korte NL verbetering/patch (optioneel, 1-2 zinnen of code)"
//     }
//   ]
// }

// "findings" is ALTIJD een array (eventueel leeg).
// Zet "file" exact op de bestandsnaam zoals in de blokken hieronder.
// `;

// // OVERRIDE: gebruik de geselecteerde prompt als die is meegegeven
//   if (customHeader && typeof customHeader === 'string' && customHeader.trim()) {
//     header = customHeader;
//   }

//   const parts = [];
//   const changeMap = {}; // filename -> Set<number> (gewijzigde HEAD-regelnummers)

//   for (const f of filesRes.data) {
//     const filename = f.filename;

//     if (/\.(png|jpe?g|gif|svg|pdf|mp4|mov|zip|lock|ico|webp|bmp|jar|exe|dll|bin)$/i.test(filename)) {
//       continue;
//     }

//     let content = '';
//     try {
//       const contentRes = await octokit.repos.getContent({
//         owner, repo, path: filename, ref: headSha
//       });
//       if (!Array.isArray(contentRes.data) && contentRes.data?.content) {
//         content = Buffer.from(contentRes.data.content, 'base64').toString('utf8');
//       }
//     } catch (_) {
//     }

//     const changed = changedHeadLinesFromPatch(f.patch || '');
//     changeMap[filename] = changed;

//     const snippet = content.slice(0, 20000);
//     const changedPreview = Array.from(changed).slice(0, 300).join(', ') || '(geen)';

//     parts.push(
// `FILE: ${filename}
// CHANGED_LINES_HEAD: ${changedPreview}

// --- START HEAD CONTENT ---
// ${snippet}
// --- END HEAD CONTENT ---

// --- START UNIFIED DIFF ---
// ${f.patch || '(geen patch beschikbaar)'}
// --- END UNIFIED DIFF ---`
//     );
//   }

//   const prompt = header + '\n\n' + parts.join('\n\n');
//   return { prompt, headSha, changeMap };
// }

async function buildPromptFromPR(prUrl, customHeader) {
  let header = `
Je bent een strikte code reviewer (HTML/CSS/JS/TS/React).

TAAL:
- Schrijf ALLE tekst in het NEDERLANDS, kort en duidelijk.

OPDRACHT:
- Review ALLEEN de regels die gemarkeerd zijn met '>>'.
- Gebruik exact de lijnnummers links in de marge (dit zijn de "nieuwe" file-regelnummers).
- Rapporteer per finding als JSON object met:
  { "file": string, "start_line": number, "end_line": number, "rule": string, "severity": "error"|"warning"|"suggestion", "message": string, "suggestion": string }
- Geef GEEN feedback over regels zonder '>>'.
- Als er niets te melden is voor een file: geef geen item.
`.trim();

  if (customHeader && typeof customHeader === "string" && customHeader.trim()) {
    header = customHeader.trim();
  }

  const { owner, repo, number } = parsePrUrl(prUrl);
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || process.env.VITE_GH_TOKEN });

  const pr = await octokit.pulls.get({ owner, repo, pull_number: number });
  const headSha = pr.data.head.sha;

  const filesRes = await octokit.pulls.listFiles({
    owner, repo, pull_number: number, per_page: 100,
  });

  const promptParts = [];
  const changeMap = {};

  for (const f of filesRes.data) {
    const { filename, status, patch } = f;

    if (!patch || /^(removed|renamed)$/i.test(status)) continue;

    const addedSet = parseAddedLinesFromPatch(patch);
    if (!addedSet || addedSet.size === 0) continue; 

    
    try {
      const contentRes = await octokit.repos.getContent({
        owner, repo, path: filename, ref: headSha,
      });

      if (Array.isArray(contentRes.data) || !contentRes.data.content) continue;
      const content = decodeBase64(contentRes.data.content.replace(/\n/g, ""));

      
      const block = buildReviewBlock(content, addedSet, /*context*/ 3);

      promptParts.push(
        [
          `FILE: ${filename}`,
          `LET OP: Review ALLEEN regels met '>>' en gebruik exact de regelnummers links.`,
          block,
        ].join("\n")
      );

      changeMap[filename] = addedSet;
    } catch {
      
    }
  }
  const filesSection = promptParts.join("\n\n---\n\n");
  const fullPrompt = `${header}\n\n${filesSection}`.trim();

  return { prompt: fullPrompt, headSha, changeMap };
}

function tryJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return { findings: [] };
}

app.post('/api/gh/review', async (req, res) => {
  try {
    const { prUrl, headSha, comments, summary } = req.body;
    if (!prUrl || !headSha) return res.status(400).json({ error: 'prUrl of headSha ontbreekt' });

    const { owner, repo, number } = parsePrUrl(prUrl);

    const review = await octokit.pulls.createReview({
      owner, repo, pull_number: number,
      commit_id: headSha,
      body: oneLine(summary || 'AI-gegenereerde feedback (beoordeeld door docent).'),
      event: 'COMMENT',
      comments: (comments || []).map(c => ({
        path: c.path,
        line: c.line,
        side: 'RIGHT',
        body: oneLine(c.body)
      }))
    });

    res.json(review.data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Review posten gefaald' });
  }
});

app.listen(PORT, () => {
  console.log(`API server op http://localhost:${PORT}`);
});

app.post('/api/prompts/create-with-files', upload.array('files', 10), async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title en content zijn verplicht' });

    
    const prompt = await createPrompt({ title, content });

    
    const { vector_store_id, assistant_id } = await ensureAssistantAndStore(prompt);

    
    const fileBlobs = (req.files || []).map(f => ({ buffer: f.buffer, originalname: f.originalname }));
    let added = [];
    if (fileBlobs.length > 0) {
      added = await uploadFilesToVectorStore(vector_store_id, fileBlobs);
      await addPromptFiles(prompt.id, added);
    }

    
    res.json({ ok: true, prompt: { ...prompt, assistant_id, vector_store_id, file_ids: JSON.stringify(added) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Aanmaken met files gefaald' });
  }
});

