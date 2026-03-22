export const CANVAS_WIDTH = 32000
export const CANVAS_HEIGHT = 32000

export type ToolCategory = 'general' | 'file' | 'text' | 'math'

export type ToolId =
  | 'select'
  | 'pen'
  | 'text'
  | 'markdown'
  | 'code'
  | 'monaco'
  | 'line'
  | 'arrow'
  | 'rectangle'
  | 'ellipse'
  | 'iframe'
  | 'html'
  | 'image'
  | 'video'
  | 'file'
  | 'compass'
  | 'graph'
  | 'latex'
  | 'ruler'
  | 'protractor'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Board {
  id: string
  name: string
  elements: BoardElement[]
  createdAt: string
  updatedAt: string
}

export interface ElementBase {
  id: string
  type: ToolId
  x: number
  y: number
  width: number
  height: number
  rotation: number
  stroke: string
  fill: string
  strokeWidth: number
  zIndex: number
  createdAt: string
  updatedAt: string
}

export interface PenElement extends ElementBase {
  type: 'pen'
  points: Point[]
}

export interface TextElement extends ElementBase {
  type: 'text' | 'markdown'
  text: string
  fontSize: number
}

export interface MonacoElement extends ElementBase {
  type: 'monaco'
  code: string
  language: string
}

export interface CodeElement extends ElementBase {
  type: 'code'
  code: string
  language: string
}

export interface ShapeElement extends ElementBase {
  type: 'line' | 'arrow' | 'rectangle' | 'ellipse'
  linePoints?: [Point, Point]
}

export interface IframeElement extends ElementBase {
  type: 'iframe'
  src: string
  title: string
}

export interface HTMLElement extends ElementBase {
  type: 'html'
  html: string
}

export interface AssetElement extends ElementBase {
  type: 'image' | 'video' | 'file'
  assetId: string
  name: string
  src: string
  mimeType: string
}

export interface CompassElement extends ElementBase {
  type: 'compass'
  radius: number
  startAngle: number
  endAngle: number
}

export interface GraphElement extends ElementBase {
  type: 'graph'
  unit: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  expressions: string[]
}

export interface LatexElement extends ElementBase {
  type: 'latex'
  latex: string
  fontSize: number
}

export interface RulerElement extends ElementBase {
  type: 'ruler'
  units: number
}

export interface ProtractorElement extends ElementBase {
  type: 'protractor'
}

export type BoardElement =
  | PenElement
  | TextElement
  | CodeElement
  | MonacoElement
  | ShapeElement
  | IframeElement
  | HTMLElement
  | AssetElement
  | CompassElement
  | GraphElement
  | LatexElement
  | RulerElement
  | ProtractorElement

export interface Asset {
  id: string
  boardId: string
  kind: 'image' | 'video' | 'file'
  name: string
  mimeType: string
  size: number
  storagePath: string
  sourceUrl: string
  createdAt: string
}

export type AIProviderType = 'gemini' | 'openai' | 'compatible'

export interface AIProviderSettings {
  providerType: AIProviderType
  apiKey: string
  baseUrl: string
  providerName: string
  modelName: string
  modelId: string
  updatedAt: string
}

export interface AgentAskRequest {
  boardId: string
  question: string
  selectedElementId?: string
  viewOrigin?: Point
  viewBounds?: Rect
  screenshotDataUrl?: string
  history?: AgentConversationMessage[]
}

export interface AgentToolEvent {
  id: string
  label: string
  detail?: string
  action?: AgentToolAction
  createdAt: string
}

export type AgentToolAction =
  | {
      type: 'move_mouse'
      targetx: number
      targety: number
    }
  | {
      type: 'move_user_viewport'
      targetx: number
      targety: number
    }
  | {
      type: 'wait'
      time: number
    }

export interface AgentConversationMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: string
}

export interface AgentAskResponse {
  answer: string
  toolEvents: AgentToolEvent[]
  thoughtSeconds?: number
}

export interface BuildCreateOperation {
  type: 'create'
  element: Partial<BoardElement> & { type: ToolId }
}

export interface BuildUpdateOperation {
  type: 'update'
  id: string
  patch: Partial<BoardElement>
}

export interface BuildDeleteOperation {
  type: 'delete'
  id: string
}

export type BuildOperation =
  | BuildCreateOperation
  | BuildUpdateOperation
  | BuildDeleteOperation

export interface AgentBuildRequest {
  boardId: string
  prompt: string
  mode?: 'build' | 'insert'
  selectedElementId?: string
  viewOrigin?: Point
  viewBounds?: Rect
  screenshotDataUrl?: string
  history?: AgentConversationMessage[]
}

export interface AgentBuildResponse {
  message: string
  operations: BuildOperation[]
  elements: BoardElement[]
  toolEvents: AgentToolEvent[]
  thoughtSeconds?: number
  boardUpdatedAt?: string
}
