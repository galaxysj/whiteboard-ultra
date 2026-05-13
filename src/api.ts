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

const parseErrorText = (value: unknown): string => {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map((entry) => parseErrorText(entry)).filter(Boolean).join(' | ')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const direct =
      (typeof record.error === 'string' && record.error) ||
      (typeof record.message === 'string' && record.message) ||
      (typeof record.detail === 'string' && record.detail)
    if (direct) return direct.trim()
    const nested =
      parseErrorText(record.error) || parseErrorText(record.details) || parseErrorText(record.message)
    if (nested) return nested
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

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
    let payload: { error?: unknown; details?: unknown; message?: unknown } | null = null
    try {
      payload = parse() as { error?: unknown; details?: unknown; message?: unknown }
    } catch {
      payload = null
    }
    throw new Error(
      (payload &&
        (parseErrorText(payload.error) ||
          parseErrorText(payload.details) ||
          parseErrorText(payload.message))) ||
        raw ||
        `Request failed with ${response.status} ${response.statusText}`.trim(),
    )
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
  uploadAsset: async (
    boardId: string,
    kind: Asset['kind'],
    file: File,
    onProgress?: (progressPercent: number) => void,
  ) => {
    const form = new FormData()
    form.append('boardId', boardId)
    form.append('kind', kind)
    form.append('file', file)

    if (!onProgress) {
      return asJson<Asset>(
        await fetch('/api/assets', {
          method: 'POST',
          body: form,
        }),
      )
    }

    return new Promise<Asset>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/assets')

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return
        const progress = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)))
        onProgress(progress)
      }

      xhr.onerror = () => reject(new Error('Network error during upload.'))

      xhr.onload = () => {
        const responseText = xhr.responseText || ''
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve((responseText ? JSON.parse(responseText) : {}) as Asset)
          } catch {
            reject(new Error('Invalid JSON response.'))
          }
          return
        }

        try {
          const payload = responseText ? JSON.parse(responseText) : {}
          const message =
            parseErrorText((payload as { error?: unknown; details?: unknown; message?: unknown }).error) ||
            parseErrorText((payload as { error?: unknown; details?: unknown; message?: unknown }).details) ||
            parseErrorText((payload as { error?: unknown; details?: unknown; message?: unknown }).message) ||
            responseText ||
            `Request failed with ${xhr.status}`
          reject(new Error(message))
        } catch {
          reject(new Error(responseText || `Request failed with ${xhr.status}`))
        }
      }

      xhr.send(form)
    })
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
