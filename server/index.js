import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json());

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3001;

// Helpers
function parsePrUrl(url) {
  const u = new URL(url);
  const [, owner, repo, , number] = u.pathname.split('/');
  if (!owner || !repo || !number) throw new Error('Ongeldige PR-URL');
  return { owner, repo, number: Number(number) };
}

// Maak set van gewijzigde HEAD-regels uit unified diff (alle + regels)
function changedHeadLinesFromPatch(patch = '') {
  const lines = patch.split('\n');
  const changed = new Set();
  let headLine = 0;

  for (const l of lines) {
    if (l.startsWith('@@')) {
      // @@ -a,b +c,d @@
      const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        headLine = Number(m[1]) - 1; // vóór de volgende regel
      }
    } else if (l.startsWith(' ')) {
      headLine += 1; // context
    } else if (l.startsWith('+')) {
      headLine += 1;        // deze +regel hoort bij HEAD
      changed.add(headLine); // markeer als gewijzigd
    } else if (l.startsWith('-')) {
      // verwijderde regel in base; headLine blijft gelijk
    }
  }
  return changed;
}

app.post('/api/ai/review-pr', async (req, res) => {
  try {
    const { prUrl } = req.body;
    if (!prUrl) {
      return res.status(400).json({ ok: false, error: 'prUrl ontbreekt' });
    }

    // 1) Bouw prompt + metadata uit echte GitHub-gegevens
    const { prompt, headSha, changeMap } = await buildPromptFromPR(prUrl);

    // 2) Vraag OpenAI om strikt JSON volgens schema
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
              // >>> BELANGRIJK: alle keys uit "properties" hieronder staan OOK in "required"
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

// Parsing (ongewijzigd laten)
let parsed = ai.output_parsed;
if (!parsed) {
  const raw = (ai.output_text ?? '').trim();
  parsed = tryJson(raw);
}

    // 4) Filter alleen findings die ÉCHT in gewijzigde HEAD-regels vallen
    const out = [];
    for (const it of (parsed?.findings || [])) {
      const file  = it.file || it.path || it.filename;
      const start = Number(it.start_line) || 0;
      const end   = Number(it.end_line) || start;
      if (!file || !changeMap[file]) continue;

      const changed = changeMap[file]; // Set<number>
      let touches = false;
      for (let ln = start; ln <= end; ln++) {
        if (changed.has(ln)) { touches = true; break; }
      }
      if (!touches) continue;

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

    // 5) Terug naar frontend in de shape die je UI verwacht
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

/** -------- Helpers hieronder plakken in hetzelfde bestand -------- **/

// Minimale promptbouwer (vul zelf aan met echte PR-diff/bestanden)
async function buildPromptFromPR(prUrl) {
  const { owner, repo, number } = parsePrUrl(prUrl);

  // PR details om HEAD SHA te krijgen
  const pr = await octokit.pulls.get({ owner, repo, pull_number: number });
  const headSha = pr.data.head.sha;

  // Lijst met gewijzigde bestanden (incl. unified diff in 'patch')
  const filesRes = await octokit.pulls.listFiles({
    owner, repo, pull_number: number, per_page: 100
  });

  // Intro + JSON voorschrift (model mag géén buiten-JSOn tekst teruggeven)
  const header = `
Je bent een strikte code reviewer (HTML/CSS/JS/TS/React).

TAAL:
- Schrijf ALLE tekstuele velden (message, suggestion, rule) in het NEDERLANDS.
- Gebruik beknopte, duidelijke Nederlandse formuleringen (geen Engels).
- Voorbeelden van terminologie:
  - "nit" -> gebruik "nit" of "kleine opmerking" (korte term is oké)
  - "warning" -> "waarschuwing"
  - "error" -> "fout"
  - "prefer const" -> "gebruik bij voorkeur const"
- Schrijf geen extra tekst buiten het JSON-object.

SCOPE:
- Analyseer ALLEEN gewijzigde regels in de PR (HEAD).
- Beperk je tot concrete, actiegerichte feedback: wat is er mis, waarom, en hoe te fixen.

OUTPUT:
- Geef ALLEEN geldig JSON (geen uitleg buiten JSON) met exact dit schema:

{
  "findings": [
    {
      "file": "string",                     // pad zoals hieronder genoemd
      "start_line": 0,                      // 1-based in HEAD
      "end_line": 0,                        // 1-based in HEAD
      "rule": "string (korte NL naam, bv. 'voorkeur const')",
      "severity": "nit|suggestion|warning|error",
      "message": "korte NL uitleg",
      "suggestion": "korte NL verbetering/patch (optioneel, 1-2 zinnen of code)"
    }
  ]
}

"findings" is ALTIJD een array (eventueel leeg).
Zet "file" exact op de bestandsnaam zoals in de blokken hieronder.
`;

  // Per-bestand blokken: HEAD content (ingekort), nummerlijst van gewijzigde regels, en de unified diff
  const parts = [];
  const changeMap = {}; // filename -> Set<number> (gewijzigde HEAD-regelnummers)

  for (const f of filesRes.data) {
    const filename = f.filename;

    // Binaire/irrelevante extensies overslaan
    if (/\.(png|jpe?g|gif|svg|pdf|mp4|mov|zip|lock|ico|webp|bmp|jar|exe|dll|bin)$/i.test(filename)) {
      continue;
    }

    // HEAD-versie van het bestand ophalen
    let content = '';
    try {
      const contentRes = await octokit.repos.getContent({
        owner, repo, path: filename, ref: headSha
      });
      if (!Array.isArray(contentRes.data) && contentRes.data?.content) {
        content = Buffer.from(contentRes.data.content, 'base64').toString('utf8');
      }
    } catch (_) {
      // file kan bv. zijn verplaatst/verwijderd; negeren
    }

    // Gewijzigde regels (HEAD) uit unified diff berekenen
    const changed = changedHeadLinesFromPatch(f.patch || '');
    changeMap[filename] = changed;

    // Inperken van content (voorkom te grote prompts)
    const snippet = content.slice(0, 20000); // ~20k chars per file is meestal ruim
    const changedPreview = Array.from(changed).slice(0, 300).join(', ') || '(geen)';

    parts.push(
`FILE: ${filename}
CHANGED_LINES_HEAD: ${changedPreview}

--- START HEAD CONTENT ---
${snippet}
--- END HEAD CONTENT ---

--- START UNIFIED DIFF ---
${f.patch || '(geen patch beschikbaar)'}
--- END UNIFIED DIFF ---`
    );
  }

  const prompt = header + '\n\n' + parts.join('\n\n');
  return { prompt, headSha, changeMap };
}

// Robuust JSON parsen (ook als er per ongeluk tekst omheen staat)
function tryJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return { findings: [] };
}


// ---------- Batch review posten ----------
app.post('/api/gh/review', async (req, res) => {
  try {
    const { prUrl, headSha, comments, summary } = req.body;
    if (!prUrl || !headSha) return res.status(400).json({ error: 'prUrl of headSha ontbreekt' });

    const { owner, repo, number } = parsePrUrl(prUrl);

    const review = await octokit.pulls.createReview({
      owner, repo, pull_number: number,
      commit_id: headSha,
      body: summary || 'AI-gegenereerde feedback (beoordeeld door docent).',
      event: 'COMMENT',
      comments: (comments || []).map(c => ({
        path: c.path, line: c.line, side: 'RIGHT', body: c.body
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