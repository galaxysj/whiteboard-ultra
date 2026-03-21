import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { AIProviderSettings, Asset, Board, BoardElement } from '../shared/types.js'

const rootDir = process.cwd()
const dataDir = path.join(rootDir, 'data')
const uploadsDir = path.join(rootDir, 'uploads')

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(uploadsDir, { recursive: true })

const db = new Database(path.join(dataDir, 'whiteboard-pro.db'))
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    elements_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    source_url TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider_type TEXT NOT NULL,
    api_key TEXT NOT NULL,
    base_url TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)

const parseElements = (raw: string): BoardElement[] => {
  try {
    return JSON.parse(raw) as BoardElement[]
  } catch {
    return []
  }
}

const normalizeBoardElements = (elements: BoardElement[]) =>
  elements.map((element, index) => ({
    ...element,
    zIndex: index + 1,
  }))

const mergeBoardElements = (
  current: BoardElement[],
  incoming: BoardElement[],
) => {
  const merged: BoardElement[] = []
  const seen = new Set<string>()

  for (const element of incoming) {
    merged.push(element)
    seen.add(element.id)
  }

  for (const element of current) {
    if (seen.has(element.id)) continue
    merged.push(element)
  }

  return normalizeBoardElements(merged)
}

const mapBoardRow = (row: {
  id: string
  name: string
  elements_json: string
  created_at: string
  updated_at: string
}): Board => ({
  id: row.id,
  name: row.name,
  elements: parseElements(row.elements_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const getUploadsDir = () => uploadsDir

export const listBoards = (): Board[] => {
  const rows = db
    .prepare(
      'SELECT id, name, elements_json, created_at, updated_at FROM boards ORDER BY updated_at DESC',
    )
    .all() as Array<{
      id: string
      name: string
      elements_json: string
      created_at: string
      updated_at: string
    }>
  return rows.map(mapBoardRow)
}

export const getBoard = (id: string): Board | undefined => {
  const row = db
    .prepare(
      'SELECT id, name, elements_json, created_at, updated_at FROM boards WHERE id = ?',
    )
    .get(id) as
    | {
        id: string
        name: string
        elements_json: string
        created_at: string
        updated_at: string
      }
    | undefined
  return row ? mapBoardRow(row) : undefined
}

export const createBoard = (name: string): Board => {
  const board: Board = {
    id: nanoid(),
    name: name.trim() || 'Untitled board',
    elements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  db.prepare(
    'INSERT INTO boards (id, name, elements_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    board.id,
    board.name,
    JSON.stringify(board.elements),
    board.createdAt,
    board.updatedAt,
  )
  return board
}

export const updateBoardName = (id: string, name: string): Board | undefined => {
  const updatedAt = new Date().toISOString()
  db.prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?').run(
    name.trim() || 'Untitled board',
    updatedAt,
    id,
  )
  return getBoard(id)
}

export const saveBoardElements = (
  id: string,
  elements: BoardElement[],
  expectedUpdatedAt?: string,
): Board | undefined => {
  const current = getBoard(id)
  if (!current) {
    return undefined
  }
  const nextElements =
    expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt
      ? mergeBoardElements(current.elements, elements)
      : normalizeBoardElements(elements)
  const updatedAt = new Date().toISOString()
  db.prepare(
    'UPDATE boards SET elements_json = ?, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(nextElements), updatedAt, id)
  return getBoard(id)
}

export const deleteBoard = (id: string) => {
  db.prepare('DELETE FROM assets WHERE board_id = ?').run(id)
  db.prepare('DELETE FROM boards WHERE id = ?').run(id)
}

export const createAsset = (input: Omit<Asset, 'id' | 'createdAt'>): Asset => {
  const asset: Asset = {
    id: nanoid(),
    ...input,
    createdAt: new Date().toISOString(),
  }
  db.prepare(
    `INSERT INTO assets (
      id, board_id, kind, name, mime_type, size, storage_path, source_url, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asset.id,
    asset.boardId,
    asset.kind,
    asset.name,
    asset.mimeType,
    asset.size,
    asset.storagePath,
    asset.sourceUrl,
    asset.createdAt,
  )
  return asset
}

export const listAssets = (boardId: string): Asset[] => {
  const rows = db
    .prepare(
      'SELECT id, board_id, kind, name, mime_type, size, storage_path, source_url, created_at FROM assets WHERE board_id = ? ORDER BY created_at DESC',
    )
    .all(boardId) as Array<{
      id: string
      board_id: string
      kind: 'image' | 'video' | 'file'
      name: string
      mime_type: string
      size: number
      storage_path: string
      source_url: string
      created_at: string
    }>
  return rows.map((row) => ({
    id: row.id,
    boardId: row.board_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    storagePath: row.storage_path,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
  }))
}

export const getAISettings = (): AIProviderSettings => {
  const row = db
    .prepare(
      'SELECT provider_type, api_key, base_url, provider_name, model_name, model_id, updated_at FROM ai_settings WHERE id = 1',
    )
    .get() as
    | {
        provider_type: AIProviderSettings['providerType']
        api_key: string
        base_url: string
        provider_name: string
        model_name: string
        model_id: string
        updated_at: string
      }
    | undefined

  if (!row) {
    return {
      providerType: 'openai',
      apiKey: '',
      baseUrl: '',
      providerName: 'OpenAI',
      modelName: 'GPT 5',
      modelId: 'gpt-5-2025-08-07',
      updatedAt: new Date(0).toISOString(),
    }
  }

  return {
    providerType: row.provider_type,
    apiKey: row.api_key,
    baseUrl: row.base_url,
    providerName: row.provider_name,
    modelName: row.model_name,
    modelId: row.model_id,
    updatedAt: row.updated_at,
  }
}

export const saveAISettings = (settings: AIProviderSettings): AIProviderSettings => {
  const updated = { ...settings, updatedAt: new Date().toISOString() }
  db.prepare(
    `INSERT INTO ai_settings (
      id, provider_type, api_key, base_url, provider_name, model_name, model_id, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider_type = excluded.provider_type,
      api_key = excluded.api_key,
      base_url = excluded.base_url,
      provider_name = excluded.provider_name,
      model_name = excluded.model_name,
      model_id = excluded.model_id,
      updated_at = excluded.updated_at`,
  ).run(
    updated.providerType,
    updated.apiKey,
    updated.baseUrl,
    updated.providerName,
    updated.modelName,
    updated.modelId,
    updated.updatedAt,
  )
  return updated
}
