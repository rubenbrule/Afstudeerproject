import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import apiRoutes from './routes/api/index.js';
import { getPrompt } from './db/prompts.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', apiRoutes)

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3001;

function parsePrUrl(url) {
  const u = new URL(url);
  const [, owner, repo, , number] = u.pathname.split('/');
  if (!owner || !repo || !number) throw new Error('Ongeldige PR-URL');
  return { owner, repo, number: Number(number) };
}

// Haal uit een unified patch ALLE 'nieuwe' (RIGHT) regels (dus alleen '+') als absolute new-file regelnummers
function parseAddedLinesFromPatch(patch = "") {
  const added = new Set();
  if (!patch) return added;

  let newLine = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const m = l.match(/\+(\d+)(?:,(\d+))?/);
      if (m) newLine = parseInt(m[1], 10) - 1; // volgende relevante regel wordt +1
      continue;
    }
    if (l.startsWith(" ") || l.startsWith("+")) {
      newLine += 1;
      if (l.startsWith("+")) {
        added.add(newLine);
      }
    }
    // '-' verhoogt alleen oldLine; negeren voor RIGHT
  }
  return added;
}

// Groepeer opeenvolgende toegevoegde regels in "spans": [[start,end], ...]
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

// Maak een compact review-blok uit de file-inhoud + toegevoegde regels.
// We tonen steeds "context" regels erboven/onder en markeren gewijzigde regels met '>>'
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
    out.push(""); // lege regel tussen blokken
  }
  return out.join("\n").trim();
}

// Eenvoudige base64 decode helper voor repo content
function decodeBase64(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

// Zet alles op één regel en escape HTML tags
function oneLine(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u2028|\u2029/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    // ▼ Escape < en > zodat HTML tags letterlijk zichtbaar zijn
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

app.post('/api/ai/review-pr', async (req, res) => {
  try {
    const { prUrl, promptId } = req.body;
    if (!prUrl) {
      return res.status(400).json({ ok: false, error: 'prUrl ontbreekt' });
    }

    // Als er een promptId is meegegeven, haal de prompt-tekst op
    let selectedPromptText = null;
    if (promptId) {
      try {
        const p = await getPrompt(promptId);
        if (p && typeof p.content === 'string' && p.content.trim()) {
          selectedPromptText = p.content;
        }
      } catch (_) {
        // Negeer fout: val automatisch terug op de default prompt
      }
    }

    const { prompt, headSha, changeMap } = await buildPromptFromPR(prUrl, selectedPromptText);

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

let parsed = ai.output_parsed;
if (!parsed) {
  const raw = (ai.output_text ?? '').trim();
  parsed = tryJson(raw);
}

    const out = [];
    for (const it of (parsed?.findings || [])) {
      const file = it.file || it.path || it.filename;
      if (!file || !changeMap[file]) continue;

      const changed = changeMap[file]; // Set<number>
      if (!changed || changed.size === 0) continue;

      // 1) Neem AI-waarden als ze er zijn
      let start = Number(it.start_line) || 0;
      let end   = Number(it.end_line)   || start;

      // 2) Fallback als AI niets bruikbaars gaf
      if (start <= 0 || end <= 0) {
        const firstChanged = Math.min(...changed);
        start = firstChanged;
        end   = firstChanged;
      }

      // 3) Als het bereik geen gewijzigde regel raakt, klemmen we naar de eerste gewijzigde regel
      let touches = false;
      for (let ln = start; ln <= end; ln++) {
        if (changed.has(ln)) { touches = true; break; }
      }
      if (!touches) {
        const firstChanged = Math.min(...changed);
        start = end = firstChanged;
      }

      out.push({
        file,
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
  // 1) Header (jouw bestaande default prompt blijft fallback)
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

  // 2) PR-info ophalen
  const { owner, repo, number } = parsePrUrl(prUrl);
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || process.env.VITE_GH_TOKEN });

  const pr = await octokit.pulls.get({ owner, repo, pull_number: number });
  const headSha = pr.data.head.sha;

  const filesRes = await octokit.pulls.listFiles({
    owner, repo, pull_number: number, per_page: 100,
  });

  // 3) Per bestand: patch parsen, content ophalen, relevante blokken maken
  const promptParts = [];
  const changeMap = {}; // file -> Set(newLine) van toegelaten regels

  for (const f of filesRes.data) {
    const { filename, status, patch } = f;

    // Sla binaire/zonder patch bestanden over
    if (!patch || /^(removed|renamed)$/i.test(status)) continue;

    const addedSet = parseAddedLinesFromPatch(patch);
    if (!addedSet || addedSet.size === 0) continue; // niets relevants

    // Repo file-inhoud ophalen op headSha
    try {
      const contentRes = await octokit.repos.getContent({
        owner, repo, path: filename, ref: headSha,
      });

      if (Array.isArray(contentRes.data) || !contentRes.data.content) continue;
      const content = decodeBase64(contentRes.data.content.replace(/\n/g, ""));

      // Bouw het compacte blok met context en >> markering
      const block = buildReviewBlock(content, addedSet, /*context*/ 3);

      promptParts.push(
        [
          `FILE: ${filename}`,
          `LET OP: Review ALLEEN regels met '>>' en gebruik exact de regelnummers links.`,
          block,
        ].join("\n")
      );

      // Bewaar de toegestane regels voor server-side validatie achteraf
      changeMap[filename] = addedSet;
    } catch {
      // kon de content niet ophalen (bijv. groot/binary) -> sla over
    }
  }

  // 4) Eindprompt samenstellen
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
      // ▼ Zet de algemene reviewtekst op één regel
      body: oneLine(summary || 'AI-gegenereerde feedback (beoordeeld door docent).'),
      event: 'COMMENT',
      // ▼ Zet elke inline comment op één regel
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

