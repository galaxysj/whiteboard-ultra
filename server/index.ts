import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { nanoid } from 'nanoid'
import {
  runAskWithToolCalls,
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
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '0.0.0.0'
const uploadsDir = getUploadsDir()
const isProduction = process.env.NODE_ENV === 'production'
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const clientDistDir = path.resolve(currentDir, '../../client')
const clientIndexPath = path.join(clientDistDir, 'index.html')

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

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.ogv',
  '.mpeg',
  '.mpg',
])

const decodeUploadFilename = (name: string) => Buffer.from(name, 'latin1').toString('utf8')

const assertAssetFileMatchesKind = (kind: Asset['kind'], file: Express.Multer.File) => {
  const decodedName = decodeUploadFilename(file.originalname)
  const extension = path.extname(decodedName).toLowerCase()
  const mimeType = (file.mimetype || '').toLowerCase()

  if (kind === 'image') {
    if (extension === '.svg' || mimeType === 'image/svg+xml') {
      const error = new Error('SVG uploads are not allowed for image embeds.')
        ; (error as Error & { status?: number }).status = 400
      throw error
    }
    if (!mimeType.startsWith('image/') && !IMAGE_EXTENSIONS.has(extension)) {
      const error = new Error('Only image files are allowed for image embeds.')
        ; (error as Error & { status?: number }).status = 400
      throw error
    }
  }

  if (kind === 'video') {
    if (!mimeType.startsWith('video/') && !VIDEO_EXTENSIONS.has(extension)) {
      const error = new Error('Only video files are allowed for video embeds.')
        ; (error as Error & { status?: number }).status = 400
      throw error
    }
  }

  return decodedName
}

const ensureBoard = (boardId: string) => {
  const board = getBoard(boardId)
  if (!board) {
    throw new Error('Board not found.')
  }
  return board
}

const getErrorPayload = (error: unknown, fallback: string) => {
  if (error instanceof Error) {
    const record = error as Error & { status?: number; details?: string }
    return {
      status: typeof record.status === 'number' ? record.status : 400,
      body: {
        error: record.message || fallback,
        details: typeof record.details === 'string' ? record.details : undefined,
      },
    }
  }
  return {
    status: 400,
    body: { error: fallback },
  }
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
  try {
    const boardId = typeof req.body?.boardId === 'string' ? req.body.boardId : ''
    const kind = req.body?.kind as Asset['kind'] | undefined

    if (!boardId || !kind || !req.file) {
      return res.status(400).json({ error: 'boardId, kind and file are required.' })
    }

    const originalName = assertAssetFileMatchesKind(kind, req.file)
    const asset = createAsset({
      boardId,
      kind,
      name: originalName,
      mimeType: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      storagePath: req.file.filename,
      sourceUrl: `/uploads/${req.file.filename}`,
    })

    return res.status(201).json(asset)
  } catch (error) {
    const payload = getErrorPayload(error, 'Failed to upload asset.')
    return res.status(payload.status).json(payload.body)
  }
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
    const response = await runAskWithToolCalls(
      settings,
      board,
      payload.question,
      payload.selectedElementId,
      payload.viewOrigin,
      payload.viewBounds,
      payload.screenshotDataUrl,
      Array.isArray(payload.history) ? payload.history : [],
    )
    res.json(response)
  } catch (error) {
    const failure = getErrorPayload(error, 'Ask failed.')
    res.status(failure.status).json(failure.body)
  }
})

app.post('/api/agent/ask/stream', async (req, res) => {
  try {
    const payload = req.body as AgentAskRequest
    const board = ensureBoard(payload.boardId)
    const settings = getAISettings()
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')
    res.write(`${JSON.stringify({ type: 'thinking_start' })}\n`)
    const result = await runAskWithToolCalls(
      settings,
      board,
      payload.question,
      payload.selectedElementId,
      payload.viewOrigin,
      payload.viewBounds,
      payload.screenshotDataUrl,
      Array.isArray(payload.history) ? payload.history : [],
    )
    res.write(`${JSON.stringify({ type: 'thought_complete', thoughtSeconds: result.thoughtSeconds ?? 0 })}\n`)
    for (const event of result.toolEvents) {
      res.write(`${JSON.stringify({ type: 'tool', event })}\n`)
    }
    const chunks = result.answer.match(/.{1,36}(\s|$)|\S+/g) ?? [result.answer]
    for (const chunk of chunks) {
      res.write(`${JSON.stringify({ type: 'token', value: chunk })}\n`)
    }
    res.write(`${JSON.stringify({ type: 'done' })}\n`)
    res.end()
  } catch (error) {
    if (!res.headersSent) {
      const failure = getErrorPayload(error, 'Ask stream failed.')
      res.status(failure.status).json(failure.body)
      return
    }
    res.end()
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
      payload.mode === 'insert' ? 'insert' : 'build',
      payload.selectedElementId,
      payload.viewOrigin,
      payload.viewBounds,
      payload.screenshotDataUrl,
      Array.isArray(payload.history) ? payload.history : [],
    )
    const saved = saveBoardElements(board.id, result.elements)
    res.json({
      ...result,
      elements: saved?.elements ?? result.elements,
      boardUpdatedAt: saved?.updatedAt,
    })
  } catch (error) {
    const failure = getErrorPayload(error, 'Build failed.')
    res.status(failure.status).json(failure.body)
  }
})

if (isProduction && fs.existsSync(clientIndexPath)) {
  app.use(express.static(clientDistDir))
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
      next()
      return
    }
    res.sendFile(clientIndexPath)
  })
}

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' })
})

const server = app.listen(port, host, () => {
  fs.mkdirSync(uploadsDir, { recursive: true })
  console.log(`Whiteboard Ultra running on http://${host}:${port}`)
})

server.on('close', () => {
  console.log('Whiteboard Ultra server closed')
})

  ; (globalThis as typeof globalThis & { __whiteboardServer?: typeof server }).__whiteboardServer = server
