// import express from 'express'
// import {
//   getAllPrompts,
//   getPrompt,
//   createPrompt,
//   updatePrompt,
//   deletePrompt
// } from '../../db/prompts.js'

// const router = express.Router()

// router.get('/', async (req, res) => {
//   const prompts = await getAllPrompts()
//   res.json(prompts)
// })

// router.get('/:id', async (req, res) => {
//   const prompt = await getPrompt(req.params.id)
//   res.json(prompt)
// })

// router.post('/', async (req, res) => {
//   const { title, content } = req.body
//   await createPrompt({ title, content })
//   res.status(201).json({ ok: true })
// })

// router.put('/:id', async (req, res) => {
//   const { title, content } = req.body
//   await updatePrompt(req.params.id, { title, content })
//   res.json({ ok: true })
// })

// router.delete('/:id', async (req, res) => {
//   await deletePrompt(req.params.id)
//   res.json({ ok: true })
// })

// export default router

import express from 'express'
import {
  getAllPrompts,
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt
} from '../../db/prompts.js'

// ✅ NIEUW: OpenAI client voor Assistant-update
import OpenAI from 'openai'
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

export default router