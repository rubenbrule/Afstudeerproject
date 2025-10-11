import express from 'express'
import { ensureAssistantHasVectorStore, waitVectorStoreReady, runAndWait } from '../../lib/openai-helpers.js';
import OpenAI from 'openai'
import {
  getAllPrompts,
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt
} from '../../db/prompts.js'


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const router = express.Router()

router.get('/', async (req, res) => {
  const prompts = await getAllPrompts()
  res.json(prompts)
})

router.get('/:id', async (req, res) => {
  const prompt = await getPrompt(req.params.id)
  res.json(prompt)
})

router.post('/', async (req, res) => {
  const { title, content } = req.body
  await createPrompt({ title, content })
  res.status(201).json({ ok: true })
})

router.put('/:id', async (req, res) => {
  const { title, content } = req.body

  // 1) DB bijwerken zoals voorheen
  await updatePrompt(req.params.id, { title, content })

  // 2) Prompt opnieuw ophalen zodat we assistant_id (en actuele title/content) hebben
  const prompt = await getPrompt(req.params.id)

  // 3) Als er een assistant gekoppeld is, update de Assistant-naam/instructions
  if (prompt?.assistant_id && process.env.OPENAI_API_KEY) {
    // Gebruik de nieuwste waarden (fallback op DB-waarden als body leeg is)
    const newName = (typeof title === 'string' && title.trim()) ? title : prompt.title
    const newInstructions = (typeof content === 'string' && content.trim()) ? content : prompt.content

    try {
      await openai.beta.assistants.update(prompt.assistant_id, {
        name: newName || undefined,       // alleen meesturen als er iets staat
        instructions: newInstructions,    // sync met jouw prompttekst
        // laat model/tools/tool_resources weg als je die niet wijzigt
      })
    } catch (e) {
      // Niet hard falen op Assistant-sync; log en ga door
      console.error('Assistant update failed:', e)
    }
  }

  // 4) Stuur de laatste staat terug (handig voor je frontend)
  const fresh = await getPrompt(req.params.id)
  res.json(fresh)
})

router.delete('/:id', async (req, res) => {
  await deletePrompt(req.params.id)
  res.json({ ok: true })
})


// helper: file_ids uit DB veld (csv of JSON) extraheren
function parseFileIds(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter(Boolean)
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter(Boolean)
    } catch {}
    // fallback: haal alleen echte OpenAI file ids uit vrije tekst/csv
    const ids = raw.match(/file_[a-zA-Z0-9]+/g) || []
    return [...new Set(ids)]
  }
  return []
}

function parseFileObjects(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(x => x && x.id);
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter(x => x && x.id);
    } catch {}
  }
  return [];
}

router.get('/:id/files', async (req, res) => {
  try {
    const id = req.params.id;
    const prompt = await getPrompt(id);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });

    const collected = new Set();

    // DB: neem ids uit file_ids (JSON met [{id,name}])
    const dbFiles = parseFileObjects(prompt.file_ids);
    dbFiles.forEach(f => collected.add(f.id));
    const dbMap = new Map(dbFiles.map(f => [f.id, f])); // voor fallback naam

    // Assistant-files
    if (prompt.assistant_id && process.env.OPENAI_API_KEY) {
      try {
        const list = await openai.beta.assistants.files.list(prompt.assistant_id);
        for (const item of list.data || []) {
          if (item?.id) collected.add(item.id);
        }
      } catch (e) {
        console.warn('assistants.files.list failed:', e?.message || e);
      }
    }

    // Vector store-files
    if (prompt.vector_store_id && process.env.OPENAI_API_KEY) {
      try {
        const list = await openai.beta.vector_stores.files.list(prompt.vector_store_id, { limit: 200 });
        for (const item of list.data || []) {
          if (item?.id) collected.add(item.id);
        }
      } catch (e) {
        console.warn('vector_stores.files.list failed:', e?.message || e);
      }
    }

    const ids = [...collected];

    // Als er geen ids zijn: klaar
    if (ids.length === 0) {
      return res.json([]);
    }

    // Als er geen API key is, of je wilt geen netwerkfout: fallback direct op DB
    if (!process.env.OPENAI_API_KEY) {
      return res.json(ids.map(fid => ({
        id: fid,
        filename: dbMap.get(fid)?.name || fid,
        bytes: null,
        created_at: null,
      })));
    }

    // Probeer metadata bij OpenAI op te halen
    const results = await Promise.allSettled(ids.map(fid => openai.files.retrieve(fid)));
    let files = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => ({
        id: r.value.id,
        filename: r.value.filename,
        bytes: r.value.bytes,
        created_at: r.value.created_at,
      }));

    // Fallback/merge: voor ids die niet ophaalbaar waren, gebruik de DB-naam
    const have = new Set(files.map(f => f.id));
    for (const fid of ids) {
      if (!have.has(fid)) {
        files.push({
          id: fid,
          filename: dbMap.get(fid)?.name || fid,
          bytes: null,
          created_at: null,
        });
      }
    }

    return res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load files' });
  }
});

// GET /api/prompts/:id/self-test
// Doet 3 checks: (1) assistant gekoppeld aan vector store, (2) vector store files klaar, (3) test-run uitvoeren
router.get('/:id/self-test', async (req, res) => {
  try {
    const id = req.params.id;
    const prompt = await getPrompt(id);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });

    const { assistant_id: assistantId, vector_store_id: vectorStoreId } = prompt;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: 'OPENAI_API_KEY ontbreekt in server/.env' });
    }
    if (!assistantId) {
      return res.status(400).json({ error: 'assistant_id ontbreekt op deze prompt (maak/opslaan met files)' });
    }
    if (!vectorStoreId) {
      return res.status(400).json({ error: 'vector_store_id ontbreekt op deze prompt (files niet/krom gekoppeld)' });
    }

    // 1) Koppeling afdwingen
    await ensureAssistantHasVectorStore(assistantId, vectorStoreId);

    // 2) Wachten tot indexeren klaar is (faalt vroeg als er mis is)
    await waitVectorStoreReady(vectorStoreId);

    // 3) Test-run
    const result = await runAndWait({
      assistantId,
      userText: 'Gebruik file_search op de gekoppelde bestanden en antwoord heel kort: "ok".'
    });

    // Antwoord terug met maximale debug-info
    return res.json({
      ok: result.status === 'completed',
      status: result.status,
      last_error: result.last_error || null,
      threadId: result.threadId,
      hint: result.status !== 'completed'
        ? 'Zie "status" en "last_error". Meest voorkomend: files nog in_progress, of tool_resources niet gekoppeld.'
        : undefined
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Self-test failed', detail: err?.message || String(err) });
  }
});

export default router