// server/routes/api/index.js
import express from 'express'
import prompts from './prompts.js'

const router = express.Router()

router.use('/prompts', prompts)

export default router