import express from 'express'
import {
  getAllPrompts,
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt
} from '../../db/prompts.js'

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
  await updatePrompt(req.params.id, { title, content })
  res.json({ ok: true })
})

router.delete('/:id', async (req, res) => {
  await deletePrompt(req.params.id)
  res.json({ ok: true })
})

export default router