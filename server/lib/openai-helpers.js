// server/lib/openai-helpers.js
import OpenAI from 'openai';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Compatibiliteits-shims: werken met oudere (beta.*) en nieuwere (camelCase) SDK-paden.
 */
function getApis() {
  const a = openai;

  const assistants =
    a.assistants ?? (a.beta && a.beta.assistants) ?? null;

  const vectorStores =
    a.vectorStores ?? (a.beta && a.beta.vector_stores) ?? null;

  const threads =
    a.threads ?? (a.beta && a.beta.threads) ?? null;

  return { assistants, vectorStores, threads };
}

/**
 * Zorg dat de Assistant de file_search tool heeft én jouw vector store gekoppeld is.
 */
export async function ensureAssistantHasVectorStore(assistantId, vectorStoreId) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY ontbreekt (server/.env).');
  }
  const { assistants } = getApis();
  if (!assistants) {
    throw new Error('OpenAI SDK: assistants-API niet beschikbaar (upgrade openai package).');
  }

  const a = await assistants.retrieve(assistantId);

  // 1) file_search tool aanzetten
  const tools = Array.isArray(a.tools) ? a.tools : [];
  const hasFileSearch = tools.some(t => t?.type === 'file_search');
  if (!hasFileSearch) {
    await assistants.update(assistantId, {
      tools: [...tools, { type: 'file_search' }],
    });
  }

  // 2) vector store koppelen
  const currentIds = a?.tool_resources?.file_search?.vector_store_ids || [];
  if (!currentIds.includes(vectorStoreId)) {
    await assistants.update(assistantId, {
      tool_resources: {
        file_search: { vector_store_ids: [...currentIds, vectorStoreId] }
      }
    });
  }
}

/**
 * Wacht tot alle files in de vector store geïndexeerd zijn.
 * Gooit een error als er failures zijn of als het te lang duurt.
 */
export async function waitVectorStoreReady(vectorStoreId, { pollMs = 1200, timeoutMs = 60000 } = {}) {
  const { vectorStores } = getApis();
  if (!vectorStores) {
    throw new Error('OpenAI SDK: vectorStores-API niet beschikbaar (upgrade openai package).');
  }

  const start = Date.now();
  while (true) {
    // Alle files ophalen met paginatie (limit max 100)
    let allFiles = [];
    let after;
    do {
      const page = await vectorStores.files.list(vectorStoreId, { limit: 100, after });
      allFiles = allFiles.concat(page?.data || []);
      after = page?.last_id || undefined;
      if (!page?.has_more) break;
    } while (true);

    if (allFiles.length === 0) return; // niets te indexeren

    // Status per file checken
    const statuses = [];
    for (const f of allFiles) {
      try {
        const meta = await openai.files.retrieve(f.id);
        statuses.push(meta?.status || 'unknown');
      } catch {
        statuses.push('unknown');
      }
    }

    const inProgress = statuses.some(s => s === 'in_progress');
    const failed     = statuses.some(s => s === 'failed');

    if (failed) throw new Error('Vector store: één of meer files zijn niet goed geïndexeerd (status=failed).');
    if (!inProgress) return; // klaar

    if (Date.now() - start > timeoutMs) {
      throw new Error('Vector store indexeren duurt te lang (timeout).');
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

/**
 * Start een run en wacht erop. Werkt met zowel openai.threads als openai.beta.threads.
 */
export async function runAndWait({ assistantId, userText, pollMs = 1200, timeoutMs = 120000 }) {
  const { threads } = getApis();
  if (!threads) {
    throw new Error('OpenAI SDK: threads-API niet beschikbaar (upgrade openai package).');
  }

  // 1) Thread + message
  const thread = await threads.create();
  await threads.messages.create(thread.id, {
    role: 'user',
    content: userText || 'Test: controleer of file_search werkt.'
  });

  // 2) Run starten
  let run = await threads.runs.create(thread.id, { assistant_id: assistantId });

  const start = Date.now();
  while (true) {
    run = await threads.runs.retrieve(thread.id, run.id);

    if (run.status === 'completed') {
      return { status: 'completed', run, threadId: thread.id };
    }
    if (run.status === 'requires_action') {
      // Voor file_search niks doen; voor function-calls moet je outputs aanleveren
      console.warn('Run requires_action (geen outputs aangeleverd):', JSON.stringify(run.required_action, null, 2));
    }
    if (['failed', 'expired', 'cancelled'].includes(run.status)) {
      console.error('Run failed:', {
        status: run.status,
        last_error: run.last_error,
        usage: run.usage,
      });
      return {
        status: run.status,
        last_error: run.last_error,
        run,
        threadId: thread.id
      };
    }
    if (Date.now() - start > timeoutMs) {
      return { status: 'timeout', run, threadId: thread.id };
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}