import db from './db.js'

export async function getAllPrompts() {
  return db.all('SELECT * FROM prompts ORDER BY created_at DESC')
}

export async function getPrompt(id) {
  return db.get('SELECT * FROM prompts WHERE id = ?', [id])
}

export async function createPrompt({ title, content }) {
  const r = await db.run(
    'INSERT INTO prompts (title, content, created_at) VALUES (?, ?, datetime("now"))',
    [title, content]
  )
  return { id: r.lastID, title, content }
}

export async function updatePrompt(id, { title, content }) {
  return db.run('UPDATE prompts SET title=?, content=? WHERE id=?', [title, content, id])
}

export async function deletePrompt(id) {
  return db.run('DELETE FROM prompts WHERE id = ?', [id])
}

export async function saveAssistantInfo(promptId, { assistant_id, vector_store_id }) {
  await db.run(
    'UPDATE prompts SET assistant_id=?, vector_store_id=? WHERE id=?',
    [assistant_id || null, vector_store_id || null, promptId]
  );
}

export async function addPromptFiles(promptId, files) {
  const row = await db.get('SELECT file_ids FROM prompts WHERE id=?', [promptId]);
  let arr = [];
  try { arr = row?.file_ids ? JSON.parse(row.file_ids) : []; } catch {}
  const map = new Map(arr.map(f => [f.id, f]));
  for (const f of files) map.set(f.id, { id: f.id, name: f.name || f.id });
  await db.run('UPDATE prompts SET file_ids=? WHERE id=?', [JSON.stringify(Array.from(map.values())), promptId]);
}