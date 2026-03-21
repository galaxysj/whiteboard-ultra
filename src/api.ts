import type {
  AIProviderSettings,
  AgentAskRequest,
  AgentAskResponse,
  AgentBuildRequest,
  AgentBuildResponse,
  Asset,
  Board,
  BoardElement,
} from '../shared/types.ts'

const asJson = async <T>(response: Response): Promise<T> => {
  const raw = await response.text()
  const parse = () => {
    if (!raw.trim()) return {} as T
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new Error(`Invalid JSON response (${response.status}).`)
    }
  }
  if (!response.ok) {
    const payload = parse() as { error?: string }
    throw new Error(payload.error ?? `Request failed with ${response.status}`)
  }
  return parse()
}

export const api = {
  listBoards: async () =>
    asJson<Board[]>(await fetch('/api/boards')),
  getBoard: async (id: string) =>
    asJson<Board>(await fetch(`/api/boards/${id}`)),
  createBoard: async (name: string) =>
    asJson<Board>(
      await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    ),
  updateBoard: async (id: string, name: string) =>
    asJson<Board>(
      await fetch(`/api/boards/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    ),
  deleteBoard: async (id: string) => {
    const response = await fetch(`/api/boards/${id}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 204) {
      throw new Error('Failed to delete board.')
    }
  },
  saveElements: async (id: string, elements: BoardElement[], updatedAt?: string) =>
    asJson<Board>(
      await fetch(`/api/boards/${id}/elements`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements, updatedAt }),
      }),
    ),
  listAssets: async (boardId: string) =>
    asJson<Asset[]>(await fetch(`/api/assets?boardId=${encodeURIComponent(boardId)}`)),
  uploadAsset: async (boardId: string, kind: Asset['kind'], file: File) => {
    const form = new FormData()
    form.append('boardId', boardId)
    form.append('kind', kind)
    form.append('file', file)
    return asJson<Asset>(
      await fetch('/api/assets', {
        method: 'POST',
        body: form,
      }),
    )
  },
  getAISettings: async () =>
    asJson<AIProviderSettings>(await fetch('/api/settings/ai')),
  saveAISettings: async (settings: AIProviderSettings) =>
    asJson<AIProviderSettings>(
      await fetch('/api/settings/ai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
    ),
  askAgent: async (payload: AgentAskRequest) =>
    asJson<AgentAskResponse>(
      await fetch('/api/agent/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    ),
  buildWithAgent: async (payload: AgentBuildRequest) =>
    asJson<AgentBuildResponse>(
      await fetch('/api/agent/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    ),
}
