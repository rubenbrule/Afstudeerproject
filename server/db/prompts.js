// server/db/prompts.js
import db from './db.js'

export async function getAllPrompts() {
  return db.all('SELECT * FROM prompts ORDER BY created_at DESC')
}

export async function getPrompt(id) {
  return db.get('SELECT * FROM prompts WHERE id = ?', [id])
}

export async function createPrompt({ title, content }) {
  return db.run('INSERT INTO prompts (title, content, created_at) VALUES (?, ?, datetime("now"))', [title, content])
}

export async function updatePrompt(id, { title, content }) {
  return db.run('UPDATE prompts SET title = ?, content = ? WHERE id = ?', [title, content, id])
}

export async function deletePrompt(id) {
  return db.run('DELETE FROM prompts WHERE id = ?', [id])
}