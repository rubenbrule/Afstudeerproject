import express from "express";
import {
  ensureAssistantHasVectorStore,
  waitVectorStoreReady,
  runAndWait,
} from "../../lib/openai-helpers.js";
import OpenAI from "openai";
import {
  getAllPrompts,
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt,
} from "../../db/prompts.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const router = express.Router();

// Haalt alle prompts op uit de database
router.get("/", async (req, res) => {
  const prompts = await getAllPrompts();
  res.json(prompts);
});

// Haalt een specifieke prompt op
router.get("/:id", async (req, res) => {
  const prompt = await getPrompt(req.params.id);
  res.json(prompt);
});

// Maakt een nieuwe prompt aan
router.post("/", async (req, res) => {
  const { title, content } = req.body;
  await createPrompt({ title, content });
  res.status(201).json({ ok: true });
});

// Update een bestaande prompt
router.put("/:id", async (req, res) => {
  const { title, content } = req.body;
  await updatePrompt(req.params.id, { title, content });

  const prompt = await getPrompt(req.params.id);

  if (prompt?.assistant_id && process.env.OPENAI_API_KEY) {
    const newName =
      typeof title === "string" && title.trim() ? title : prompt.title;
    const newInstructions =
      typeof content === "string" && content.trim() ? content : prompt.content;

    try {
      await openai.beta.assistants.update(prompt.assistant_id, {
        name: newName || undefined, // alleen meesturen als er iets staat
        instructions: newInstructions, 
      });
    } catch (e) {
      console.error("Assistant update failed:", e);
    }
  }
  const fresh = await getPrompt(req.params.id);
  res.json(fresh);
});

// Verwijdert een prompt permanent
router.delete("/:id", async (req, res) => {
  await deletePrompt(req.params.id);
  res.json({ ok: true });
});

// helper: file_ids uit DB veld (csv of JSON) extraheren
function parseFileIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter(Boolean);
    } catch {}
    // fallback: haal alleen echte OpenAI file ids uit vrije tekst/csv
    const ids = raw.match(/file_[a-zA-Z0-9]+/g) || [];
    return [...new Set(ids)];
  }
  return [];
}

function parseFileObjects(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x) => x && x.id);
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((x) => x && x.id);
    } catch {}
  }
  return [];
}

router.get("/:id/files", async (req, res) => {
  try {
    const id = req.params.id;
    const prompt = await getPrompt(id);
    if (!prompt) return res.status(404).json({ error: "Prompt not found" });

    const collected = new Set();

    const dbFiles = parseFileObjects(prompt.file_ids);
    dbFiles.forEach((f) => collected.add(f.id));
    const dbMap = new Map(dbFiles.map((f) => [f.id, f])); 

    // Assistant-files
    if (prompt.assistant_id && process.env.OPENAI_API_KEY) {
      try {
        const list = await openai.beta.assistants.files.list(
          prompt.assistant_id
        );
        for (const item of list.data || []) {
          if (item?.id) collected.add(item.id);
        }
      } catch (e) {
        console.warn("assistants.files.list failed:", e?.message || e);
      }
    }

    // Vector store-files
    if (prompt.vector_store_id && process.env.OPENAI_API_KEY) {
      try {
        const list = await openai.beta.vector_stores.files.list(
          prompt.vector_store_id,
          { limit: 200 }
        );
        for (const item of list.data || []) {
          if (item?.id) collected.add(item.id);
        }
      } catch (e) {
        console.warn("vector_stores.files.list failed:", e?.message || e);
      }
    }

    const ids = [...collected];
    if (ids.length === 0) {
      return res.json([]);
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.json(
        ids.map((fid) => ({
          id: fid,
          filename: dbMap.get(fid)?.name || fid,
          bytes: null,
          created_at: null,
        }))
      );
    }

    const results = await Promise.allSettled(
      ids.map((fid) => openai.files.retrieve(fid))
    );
    let files = results
      .filter((r) => r.status === "fulfilled" && r.value)
      .map((r) => ({
        id: r.value.id,
        filename: r.value.filename,
        bytes: r.value.bytes,
        created_at: r.value.created_at,
      }));

    const have = new Set(files.map((f) => f.id));
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
    res.status(500).json({ error: "Failed to load files" });
  }
});

// test
router.get("/:id/self-test", async (req, res) => {
  try {
    const id = req.params.id;
    const prompt = await getPrompt(id);
    if (!prompt) return res.status(404).json({ error: "Prompt not found" });

    const { assistant_id: assistantId, vector_store_id: vectorStoreId } =
      prompt;

    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(400)
        .json({ error: "OPENAI_API_KEY ontbreekt in server/.env" });
    }
    if (!assistantId) {
      return res
        .status(400)
        .json({
          error:
            "assistant_id ontbreekt op deze prompt (maak/opslaan met files)",
        });
    }
    if (!vectorStoreId) {
      return res
        .status(400)
        .json({
          error:
            "vector_store_id ontbreekt op deze prompt (files niet/krom gekoppeld)",
        });
    }

    await ensureAssistantHasVectorStore(assistantId, vectorStoreId);
    await waitVectorStoreReady(vectorStoreId);

    const result = await runAndWait({
      assistantId,
      userText:
        'Gebruik file_search op de gekoppelde bestanden en antwoord heel kort: "ok".',
    });

    return res.json({
      ok: result.status === "completed",
      status: result.status,
      last_error: result.last_error || null,
      threadId: result.threadId,
      hint:
        result.status !== "completed"
          ? 'Zie "status" en "last_error". Meest voorkomend: files nog in_progress, of tool_resources niet gekoppeld.'
          : undefined,
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Self-test failed", detail: err?.message || String(err) });
  }
});

export default router;
