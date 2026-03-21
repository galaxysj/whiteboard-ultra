import fs from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { nanoid } from 'nanoid'
import {
  boardContext,
  generateAgentResponse,
  runBuildWithToolCalls,
} from './ai.js'
import {
  createAsset,
  createBoard,
  deleteBoard,
  getAISettings,
  getBoard,
  getUploadsDir,
  listAssets,
  listBoards,
  saveAISettings,
  saveBoardElements,
  updateBoardName,
} from './db.js'
import type {
  AIProviderSettings,
  AgentAskRequest,
  AgentBuildRequest,
  Asset,
  BoardElement,
} from '../shared/types.js'

const app = express()
const port = 3001
const host = process.env.HOST || '0.0.0.0'
const uploadsDir = getUploadsDir()

app.use(cors())
app.use(express.json({ limit: '20mb' }))
app.use('/uploads', express.static(uploadsDir))

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDir),
  filename: (_req, file, callback) => {
    const safeExt = path.extname(file.originalname)
    callback(null, `${Date.now()}-${nanoid()}${safeExt}`)
  },
})

const upload = multer({ storage })

const ensureBoard = (boardId: string) => {
  const board = getBoard(boardId)
  if (!board) {
    throw new Error('Board not found.')
  }
  return board
}

const normalizeSettings = (input: Partial<AIProviderSettings>): AIProviderSettings => ({
  providerType: input.providerType ?? 'openai',
  apiKey: input.apiKey ?? '',
  baseUrl: input.baseUrl ?? '',
  providerName: input.providerName ?? 'OpenAI',
  modelName: input.modelName ?? 'GPT 5',
  modelId: input.modelId ?? 'gpt-5-2025-08-07',
  updatedAt: input.updatedAt ?? new Date().toISOString(),
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/boards', (_req, res) => {
  const boards = listBoards()
  if (boards.length === 0) {
    const seed = createBoard('Welcome board')
    return res.json([seed])
  }
  return res.json(boards)
})

app.post('/api/boards', (req, res) => {
  const board = createBoard(typeof req.body?.name === 'string' ? req.body.name : 'Untitled board')
  res.status(201).json(board)
})

app.get('/api/boards/:id', (req, res) => {
  const board = getBoard(req.params.id)
  if (!board) {
    return res.status(404).json({ error: 'Board not found.' })
  }
  return res.json(board)
})

app.patch('/api/boards/:id', (req, res) => {
  try {
    const board = ensureBoard(req.params.id)
    const next = updateBoardName(board.id, typeof req.body?.name === 'string' ? req.body.name : board.name)
    res.json(next)
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Board not found.' })
  }
})

app.delete('/api/boards/:id', (req, res) => {
  deleteBoard(req.params.id)
  res.status(204).send()
})

app.put('/api/boards/:id/elements', (req, res) => {
  const elements = Array.isArray(req.body?.elements) ? (req.body.elements as BoardElement[]) : []
  const updatedAt = typeof req.body?.updatedAt === 'string' ? req.body.updatedAt : undefined
  const board = saveBoardElements(req.params.id, elements, updatedAt)
  if (!board) {
    return res.status(404).json({ error: 'Board not found.' })
  }
  return res.json(board)
})

app.get('/api/assets', (req, res) => {
  const boardId = typeof req.query.boardId === 'string' ? req.query.boardId : ''
  if (!boardId) {
    return res.status(400).json({ error: 'boardId is required.' })
  }
  return res.json(listAssets(boardId))
})

app.post('/api/assets', upload.single('file'), (req, res) => {
  const boardId = typeof req.body?.boardId === 'string' ? req.body.boardId : ''
  const kind = req.body?.kind as Asset['kind'] | undefined

  if (!boardId || !kind || !req.file) {
    return res.status(400).json({ error: 'boardId, kind and file are required.' })
  }

  const asset = createAsset({
    boardId,
    kind,
    name: req.file.originalname,
    mimeType: req.file.mimetype || 'application/octet-stream',
    size: req.file.size,
    storagePath: req.file.filename,
    sourceUrl: `/uploads/${req.file.filename}`,
  })

  return res.status(201).json(asset)
})

app.get('/api/settings/ai', (_req, res) => {
  res.json(getAISettings())
})

app.put('/api/settings/ai', (req, res) => {
  const settings = saveAISettings(normalizeSettings(req.body))
  res.json(settings)
})

app.post('/api/agent/ask', async (req, res) => {
  try {
    const payload = req.body as AgentAskRequest
    const board = ensureBoard(payload.boardId)
    const settings = getAISettings()
    const response = await generateAgentResponse(
      settings,
      'You are Whiteboard Pro assistant. Answer in concise English based on the provided whiteboard state only. If the board does not contain enough information, say so clearly.',
      `${JSON.stringify(boardContext(board, payload.selectedElementId, payload.viewOrigin), null, 2)}\n\nUser question:\n${payload.question}`,
    )
    res.json({ answer: response.trim() })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Ask failed.' })
  }
})

app.post('/api/agent/build', async (req, res) => {
  try {
    const payload = req.body as AgentBuildRequest
    const board = ensureBoard(payload.boardId)
    const settings = getAISettings()
    const result = await runBuildWithToolCalls(
      settings,
      board,
      payload.prompt,
      payload.selectedElementId,
      payload.viewOrigin,
    )
    const saved = saveBoardElements(board.id, result.elements)
    res.json({
      ...result,
      elements: saved?.elements ?? result.elements,
    })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Build failed.' })
  }
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' })
})

app.listen(port, host, () => {
  fs.mkdirSync(uploadsDir, { recursive: true })
  console.log(`Whiteboard Pro API running on http://${host}:${port}`)
})
