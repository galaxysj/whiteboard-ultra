import { useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import getStroke from 'perfect-freehand'
import {
  ALargeSmall,
  ArrowRight,
  Calculator,
  Check,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleX,
  Code2,
  Compass,
  Eraser,
  File,
  FileCode2,
  FileImage,
  FileVideo,
  FolderOpen,
  Gauge,
  Grid3x3,
  MessageSquare,
  Minus,
  MousePointer2,
  Pen,
  PenTool,
  Plus,
  RectangleHorizontal,
  Ruler,
  Save,
  Scan,
  Send,
  SidebarClose,
  SidebarOpen,
  SlidersHorizontal,
  Settings2,
  SquareCode,
  Sparkles,
  Type,
  Trash2,
  Undo,
  Redo,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { api } from './api.ts'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type AIProviderSettings,
  type AgentBuildResponse,
  type Asset,
  type Board,
  type BoardElement,
  type CodeElement,
  type MonacoElement,
  type Point,
  type ShapeElement,
  type ToolCategory,
  type ToolId,
} from '../shared/types.ts'
import {
  createPenElement,
  createPlacedElement,
  createShapeElement,
  normalizeRect,
  renderLatexToHtml,
  renderMarkdownToHtml,
  resizeElement,
  SHAPE_MIN_SIZE,
  translateElement,
  updateElement,
} from './lib/board.ts'

type Viewport = { x: number; y: number; zoom: number }
type AgentMode = 'chat' | 'build'
type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
type ProviderPreset = {
  id: string
  name: string
  providerType: AIProviderSettings['providerType']
  baseUrl: string
  apiKey: string
}
type SettingsSection = 'workspace' | 'ai'
type ModelPreset = {
  id: string
  name: string
  modelId: string
  providerId: string
}
type DropdownOption = {
  value: string
  label: string
}
type CanvasToolId = ToolId | 'eraser-stroke'
type DraftState =
  | { type: 'shape'; tool: 'line' | 'arrow' | 'rectangle' | 'ellipse'; start: Point; end: Point }
  | { type: 'pen'; rawPoints: Point[]; points: Point[] }
  | { type: 'eraser'; points: Point[] }
  | null
type DragState =
  | { kind: 'canvas'; start: Point; origin: { x: number; y: number } }
  | { kind: 'move'; elementId: string; start: Point; original: BoardElement }
  | { kind: 'resize'; elementId: string; start: Point; original: BoardElement }
  | {
      kind: 'compass-radius'
      elementId: string
      center: Point
      original: BoardElement
    }
  | {
      kind: 'rotate'
      elementId: string
      center: Point
      startAngle: number
      originalRotation: number
      original: BoardElement
    }
  | {
      kind: 'compass-draw'
      elementId: string
      center: Point
      radius: number
      handleRadius: number
      angleOffset: number
      stroke: string
      strokeWidth: number
      startContinuousAngle: number
      minContinuousAngle: number
      maxContinuousAngle: number
      points: Point[]
      continuousAngle: number
      endAngle: number
    }
  | null

type ModalState =
  | {
      kind: 'text'
      title: string
      message?: string
      placeholder?: string
      initialValue: string
      confirmLabel?: string
    }
  | {
      kind: 'confirm'
      title: string
      message: string
      confirmLabel?: string
      danger?: boolean
    }
  | null

type TextModalConfig = Extract<ModalState, { kind: 'text' }>
type ConfirmModalConfig = Extract<ModalState, { kind: 'confirm' }>

const MONACO_LANGUAGES = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'json', label: 'JSON' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'sql', label: 'SQL' },
  { value: 'yaml', label: 'YAML' },
  { value: 'bash', label: 'Bash' },
] as const

const TOOL_DEFS: Array<{ id: CanvasToolId; label: string; category: ToolCategory; icon: typeof MousePointer2 }> = [
  { id: 'select', label: 'Select', category: 'general', icon: MousePointer2 },
  { id: 'pen', label: 'Pen', category: 'general', icon: PenTool },
  { id: 'eraser-stroke', label: 'Eraser', category: 'general', icon: Eraser },
  { id: 'line', label: 'Line', category: 'general', icon: Minus },
  { id: 'arrow', label: 'Arrow', category: 'general', icon: ArrowRight },
  { id: 'rectangle', label: 'Rectangle', category: 'general', icon: RectangleHorizontal },
  { id: 'ellipse', label: 'Circle', category: 'general', icon: Circle },
  { id: 'iframe', label: 'Embed', category: 'file', icon: FileCode2 },
  { id: 'image', label: 'Image', category: 'file', icon: FileImage },
  { id: 'video', label: 'Video', category: 'file', icon: FileVideo },
  { id: 'file', label: 'Other Files', category: 'file', icon: File },
  { id: 'text', label: 'Text', category: 'text', icon: Type },
  { id: 'markdown', label: 'Markdown', category: 'text', icon: ALargeSmall },
  { id: 'code', label: 'Normal Code', category: 'text', icon: Code2 },
  { id: 'monaco', label: 'Monaco Editor', category: 'text', icon: SquareCode },
  { id: 'compass', label: 'Compass', category: 'math', icon: Compass },
  { id: 'graph', label: 'Graph', category: 'math', icon: Grid3x3 },
  { id: 'latex', label: 'LaTeX', category: 'math', icon: Scan },
  { id: 'ruler', label: 'Ruler', category: 'math', icon: Ruler },
  { id: 'protractor', label: 'Protractor', category: 'math', icon: Gauge },
]
const CATEGORY_TOOL_DEFS = TOOL_DEFS.filter((item) => item.id !== 'select')
const CATEGORY_DEFS: Array<{ id: ToolCategory; label: string; icon: typeof MousePointer2 }> = [
  { id: 'general', label: 'Pen tools', icon: Pen },
  { id: 'file', label: 'Embed tools', icon: File },
  { id: 'text', label: 'Text tools', icon: Type },
  { id: 'math', label: 'Math tools', icon: Calculator },
]

const defaultAISettings: AIProviderSettings = {
  providerType: 'openai',
  apiKey: '',
  baseUrl: '',
  providerName: 'OpenAI',
  modelName: 'GPT 5',
  modelId: 'gpt-5-2025-08-07',
  updatedAt: new Date(0).toISOString(),
}
const AI_PROVIDER_LIST_STORAGE_KEY = 'whiteboard.ai.provider-list'
const AI_MODEL_LIST_STORAGE_KEY = 'whiteboard.ai.model-list'

const defaultProviderPresets: ProviderPreset[] = [
  { id: 'provider-openai', name: 'OpenAI', providerType: 'openai', baseUrl: '', apiKey: '' },
  { id: 'provider-gemini', name: 'Gemini', providerType: 'gemini', baseUrl: '', apiKey: '' },
  {
    id: 'provider-compatible',
    name: 'OpenAI Compatible',
    providerType: 'compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
  },
]

const defaultModelPresets: ModelPreset[] = [
  { id: 'model-gpt-5', name: 'GPT 5', modelId: 'gpt-5-2025-08-07', providerId: 'provider-openai' },
  { id: 'model-gpt-5-mini', name: 'GPT 5 Mini', modelId: 'gpt-5-mini-2025-08-07', providerId: 'provider-openai' },
  { id: 'model-gemini-3-flash', name: 'Gemini 3 Flash', modelId: 'gemini-3-flash-preview', providerId: 'provider-gemini' },
  { id: 'model-gemini-3.1-pro', name: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro-preview', providerId: 'provider-gemini' },
]

const createLocalId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const parseProviderPresets = (raw: string | null) => {
  if (!raw) return defaultProviderPresets
  try {
    const parsed = JSON.parse(raw) as ProviderPreset[]
    if (!Array.isArray(parsed)) return defaultProviderPresets
    const filtered = parsed
      .filter(
        (item) =>
          typeof item?.id === 'string' &&
          typeof item?.name === 'string' &&
          (item?.providerType === 'openai' || item?.providerType === 'gemini' || item?.providerType === 'compatible') &&
          typeof item?.baseUrl === 'string',
      )
      .map((item) => ({
        ...item,
        apiKey: typeof item?.apiKey === 'string' ? item.apiKey : '',
      }))
    return filtered.length > 0 ? filtered : defaultProviderPresets
  } catch {
    return defaultProviderPresets
  }
}
const parseModelPresets = (raw: string | null) => {
  if (!raw) return defaultModelPresets
  try {
    const parsed = JSON.parse(raw) as ModelPreset[]
    if (!Array.isArray(parsed)) return defaultModelPresets
    const filtered = parsed.filter(
      (item) =>
        typeof item?.id === 'string' &&
        typeof item?.name === 'string' &&
        typeof item?.modelId === 'string' &&
        typeof item?.providerId === 'string',
    )
    return filtered.length > 0 ? filtered : defaultModelPresets
  } catch {
    return defaultModelPresets
  }
}

function CustomDropdown({
  value,
  options,
  onChange,
  className,
  placeholder = 'Select',
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  className?: string
  placeholder?: string
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value) ?? null

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div className={`custom-dropdown ${className ?? ''}`} ref={rootRef}>
      <button type="button" className="custom-dropdown-trigger" onClick={() => setOpen((prev) => !prev)}>
        <span>{selected?.label ?? placeholder}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="custom-dropdown-menu">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`custom-dropdown-item ${option.value === value ? 'active' : ''}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const sizeFormatter = new Intl.NumberFormat('en-US')
const boardCenter = () => ({ x: CANVAS_WIDTH / 2 - 800, y: CANVAS_HEIGHT / 2 - 600, zoom: 1 })
const GRID_STEP = 36
const DEFAULT_ERASER_RADIUS = 12
const DEFAULT_PEN_STROKE_WIDTH = 2
const DEFAULT_PEN_COLOR = '#183153'
const DEFAULT_SHAPE_COLOR = '#183153'
const DEFAULT_SHAPE_STROKE_WIDTH = 2
const DEFAULT_SHAPE_FILLED = false
const TINY_SHAPE_THRESHOLD = 0.75
const COMPASS_WIDTH = 400
const COMPASS_SOURCE_WIDTH = 300
const COMPASS_SOURCE_HEIGHT = 420
const COMPASS_SCALE = COMPASS_WIDTH / COMPASS_SOURCE_WIDTH
const PEN_MIN_POINT_DISTANCE = 0.9
const PEN_LOW_SPEED_SMOOTH = 0.12
const PEN_HIGH_SPEED_SMOOTH = 0.42
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const normalizeAngle = (angle: number) => ((angle % 360) + 360) % 360
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const scaleCompassPoint = (x: number, y: number) => ({ x: x * COMPASS_SCALE, y: y * COMPASS_SCALE })
const COMPASS_HINGE_SOURCE = { x: 150, y: 80 }
const COMPASS_HANDLE_CENTER_SOURCE = { x: 150.514076, y: 83.084455 }
const COMPASS_LEFT_START_SOURCE = { x: 138, y: 96 }
const COMPASS_RIGHT_START_SOURCE = { x: 162, y: 96 }
const COMPASS_LEFT_TIP_SOURCE = { x: 67.465099663, y: 332.962346014 }
const COMPASS_RIGHT_TIP_BASE_SOURCE = { x: 232.565, y: 332.552 }
const COMPASS_HINGE = scaleCompassPoint(COMPASS_HINGE_SOURCE.x, COMPASS_HINGE_SOURCE.y)
const COMPASS_HANDLE_CENTER = scaleCompassPoint(COMPASS_HANDLE_CENTER_SOURCE.x, COMPASS_HANDLE_CENTER_SOURCE.y)
const COMPASS_LEFT_START = scaleCompassPoint(COMPASS_LEFT_START_SOURCE.x, COMPASS_LEFT_START_SOURCE.y)
const COMPASS_RIGHT_START = scaleCompassPoint(COMPASS_RIGHT_START_SOURCE.x, COMPASS_RIGHT_START_SOURCE.y)
const COMPASS_LEFT_TIP = scaleCompassPoint(COMPASS_LEFT_TIP_SOURCE.x, COMPASS_LEFT_TIP_SOURCE.y)
const COMPASS_RIGHT_TIP_BASE = scaleCompassPoint(COMPASS_RIGHT_TIP_BASE_SOURCE.x, COMPASS_RIGHT_TIP_BASE_SOURCE.y)
const COMPASS_LEFT_LEG_LENGTH = distance(COMPASS_HINGE, COMPASS_LEFT_TIP)
const COMPASS_RIGHT_LEG_LENGTH = distance(COMPASS_HINGE, COMPASS_RIGHT_TIP_BASE)
const COMPASS_LEFT_ABSOLUTE_ANGLE = Math.atan2(COMPASS_LEFT_TIP.y - COMPASS_HINGE.y, COMPASS_LEFT_TIP.x - COMPASS_HINGE.x)
const COMPASS_RIGHT_BASE_ABSOLUTE_ANGLE = Math.atan2(
  COMPASS_RIGHT_TIP_BASE.y - COMPASS_HINGE.y,
  COMPASS_RIGHT_TIP_BASE.x - COMPASS_HINGE.x,
)
const COMPASS_MIN_OPEN_ANGLE = (4 * Math.PI) / 180
const COMPASS_MAX_OPEN_ANGLE = (70 * Math.PI) / 180
const degreesToRadians = (angle: number) => (angle * Math.PI) / 180
const radiansToDegrees = (angle: number) => (angle * 180) / Math.PI
const signedAngleDelta = (target: number, source: number) => {
  const delta = normalizeAngle(target - source)
  return delta > 180 ? delta - 360 : delta
}
const pointOnCircle = (center: Point, radius: number, angle: number) => ({
  x: center.x + Math.cos(degreesToRadians(angle)) * radius,
  y: center.y + Math.sin(degreesToRadians(angle)) * radius,
})
const getCompassAngleFromHandle = (center: Point, angleOffset: number, point: Point) => {
  const handleAngle = normalizeAngle(radiansToDegrees(Math.atan2(point.y - center.y, point.x - center.x)))
  return normalizeAngle(handleAngle + angleOffset)
}
const unwrapCompassAngle = (rawAngle: number, previousAngle: number) => {
  const previousNormalized = normalizeAngle(previousAngle)
  let delta = rawAngle - previousNormalized
  if (delta > 180) delta -= 360
  if (delta < -180) delta += 360
  return previousAngle + delta
}
const buildCompassArcPoints = (center: Point, radius: number, startAngle: number, endAngle: number) => {
  const delta = endAngle - startAngle
  const arcLength = (Math.abs(delta) * Math.PI * radius) / 180
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(delta) / 3, arcLength / 10)))
  return Array.from({ length: steps + 1 }, (_, index) =>
    pointOnCircle(center, radius, startAngle + (delta * index) / steps),
  )
}
const getCompassRightTipForAngle = (openAngle: number) => {
  const absoluteAngle = COMPASS_LEFT_ABSOLUTE_ANGLE - openAngle
  return {
    x: COMPASS_HINGE.x + Math.cos(absoluteAngle) * COMPASS_RIGHT_LEG_LENGTH,
    y: COMPASS_HINGE.y + Math.sin(absoluteAngle) * COMPASS_RIGHT_LEG_LENGTH,
  }
}
const getCompassSpreadForAngle = (openAngle: number) => distance(COMPASS_LEFT_TIP, getCompassRightTipForAngle(openAngle))
const COMPASS_MIN_SPREAD = getCompassSpreadForAngle(COMPASS_MIN_OPEN_ANGLE)
const COMPASS_MAX_SPREAD = getCompassSpreadForAngle(COMPASS_MAX_OPEN_ANGLE)
const getCompassAngleForSpread = (spread: number) => {
  const target = clamp(spread, COMPASS_MIN_SPREAD, COMPASS_MAX_SPREAD)
  const cosTheta =
    (COMPASS_LEFT_LEG_LENGTH ** 2 + COMPASS_RIGHT_LEG_LENGTH ** 2 - target ** 2) /
    (2 * COMPASS_LEFT_LEG_LENGTH * COMPASS_RIGHT_LEG_LENGTH)
  return clamp(Math.acos(clamp(cosTheta, -1, 1)), COMPASS_MIN_OPEN_ANGLE, COMPASS_MAX_OPEN_ANGLE)
}
const stabilizePenSample = (prevRaw: Point, prevSmooth: Point, nextRaw: Point) => {
  const rawDistance = distance(prevRaw, nextRaw)
  const t = clamp(rawDistance / 14, 0, 1)
  const alpha = PEN_LOW_SPEED_SMOOTH + (PEN_HIGH_SPEED_SMOOTH - PEN_LOW_SPEED_SMOOTH) * t
  return {
    x: prevSmooth.x + (nextRaw.x - prevSmooth.x) * alpha,
    y: prevSmooth.y + (nextRaw.y - prevSmooth.y) * alpha,
  }
}
const getStrokePolygon = (points: Point[], strokeWidth: number) => {
  const input = points.map((point) => [point.x, point.y, 0.5] as [number, number, number])
  return getStroke(input, {
    size: Math.max(1.5, strokeWidth * 2.4),
    thinning: 0.2,
    smoothing: 0.7,
    streamline: 0.72,
    simulatePressure: false,
    easing: (t) => t,
    last: true,
  })
}
const drawStrokePolygon = (ctx: CanvasRenderingContext2D, polygon: number[][], color: string) => {
  if (polygon.length === 0) return
  ctx.beginPath()
  if (polygon.length < 3) {
    ctx.moveTo(polygon[0][0], polygon[0][1])
    for (let index = 1; index < polygon.length; index += 1) {
      ctx.lineTo(polygon[index][0], polygon[index][1])
    }
  } else {
    const firstMidX = (polygon[0][0] + polygon[1][0]) / 2
    const firstMidY = (polygon[0][1] + polygon[1][1]) / 2
    ctx.moveTo(firstMidX, firstMidY)
    for (let index = 1; index < polygon.length; index += 1) {
      const current = polygon[index]
      const next = polygon[(index + 1) % polygon.length]
      const midX = (current[0] + next[0]) / 2
      const midY = (current[1] + next[1]) / 2
      ctx.quadraticCurveTo(current[0], current[1], midX, midY)
    }
  }
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}
const strokePolygonToPath = (polygon: number[][]) => {
  if (polygon.length === 0) return ''
  if (polygon.length < 3) {
    return polygon.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`).join(' ')
  }
  const firstMidX = (polygon[0][0] + polygon[1][0]) / 2
  const firstMidY = (polygon[0][1] + polygon[1][1]) / 2
  const segments = [`M ${firstMidX} ${firstMidY}`]
  for (let index = 1; index < polygon.length; index += 1) {
    const current = polygon[index]
    const next = polygon[(index + 1) % polygon.length]
    const midX = (current[0] + next[0]) / 2
    const midY = (current[1] + next[1]) / 2
    segments.push(`Q ${current[0]} ${current[1]} ${midX} ${midY}`)
  }
  segments.push('Z')
  return segments.join(' ')
}
const getShapeFillColor = (hex: string) => {
  const normalized = hex.replace('#', '')
  const value =
    normalized.length === 3
      ? normalized
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : normalized
  if (value.length !== 6) return 'rgba(24, 49, 83, 0.18)'
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, 0.18)`
}
const isTinyShapeAxis = (size: number) => size <= TINY_SHAPE_THRESHOLD
const drawCollapsedStroke = (
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) => {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}
const drawRectanglePreview = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  filled: boolean,
) => {
  const thinX = isTinyShapeAxis(width)
  const thinY = isTinyShapeAxis(height)
  if (thinX && thinY) {
    drawCollapsedStroke(ctx, x + width / 2, y + height / 2, x + width / 2, y + height / 2)
    return
  }
  if (thinX) {
    drawCollapsedStroke(ctx, x + width / 2, y, x + width / 2, y + height)
    return
  }
  if (thinY) {
    drawCollapsedStroke(ctx, x, y + height / 2, x + width, y + height / 2)
    return
  }
  ctx.beginPath()
  ctx.rect(x, y, width, height)
  if (filled) ctx.fill()
  ctx.stroke()
}
const drawEllipsePreview = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  filled: boolean,
) => {
  const thinX = isTinyShapeAxis(width)
  const thinY = isTinyShapeAxis(height)
  if (thinX && thinY) {
    drawCollapsedStroke(ctx, x + width / 2, y + height / 2, x + width / 2, y + height / 2)
    return
  }
  if (thinX) {
    drawCollapsedStroke(ctx, x + width / 2, y, x + width / 2, y + height)
    return
  }
  if (thinY) {
    drawCollapsedStroke(ctx, x, y + height / 2, x + width, y + height / 2)
    return
  }
  ctx.beginPath()
  ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
  if (filled) ctx.fill()
  ctx.stroke()
}
const renderRectangleSvg = (element: ShapeElement) => {
  const svgWidth = Math.max(1, element.width)
  const svgHeight = Math.max(1, element.height)
  const thinX = isTinyShapeAxis(element.width)
  const thinY = isTinyShapeAxis(element.height)
  if (thinX && thinY) {
    return (
      <svg width={svgWidth} height={svgHeight} style={{ overflow: 'visible' }}>
        <line
          x1={element.width / 2}
          y1={element.height / 2}
          x2={element.width / 2}
          y2={element.height / 2}
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          strokeLinecap="round"
          shapeRendering="geometricPrecision"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }
  if (thinX) {
    return (
      <svg width={svgWidth} height={svgHeight} style={{ overflow: 'visible' }}>
        <line
          x1={element.width / 2}
          y1={0}
          x2={element.width / 2}
          y2={element.height}
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          strokeLinecap="round"
          shapeRendering="geometricPrecision"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }
  if (thinY) {
    return (
      <svg width={svgWidth} height={svgHeight} style={{ overflow: 'visible' }}>
        <line
          x1={0}
          y1={element.height / 2}
          x2={element.width}
          y2={element.height / 2}
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          strokeLinecap="round"
          shapeRendering="geometricPrecision"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }
  return (
    <svg width={svgWidth} height={svgHeight} style={{ overflow: 'visible' }}>
      <rect
        x={0}
        y={0}
        width={element.width}
        height={element.height}
        fill={element.fill}
        stroke={element.stroke}
        strokeWidth={element.strokeWidth}
        strokeLinejoin="round"
        shapeRendering="geometricPrecision"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
const renderEllipseSvg = (element: ShapeElement) => {
  const svgWidth = Math.max(1, element.width)
  const svgHeight = Math.max(1, element.height)
  const thinX = isTinyShapeAxis(element.width)
  const thinY = isTinyShapeAxis(element.height)
  if (thinX && thinY) {
    return (
      <svg width={svgWidth} height={svgHeight} style={{ overflow: 'visible' }}>
        <line
          x1={element.width / 2}
          y1={element.height / 2}
          x2={element.width / 2}
          y2={element.height / 2}
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          strokeLinecap="round"
          shapeRendering="geometricPrecision"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }
  if (thinX) {
    return (
      <svg width={svgWidth} height={svgHeight} style={{ overflow: 'visible' }}>
        <line
          x1={element.width / 2}
          y1={0}
          x2={element.width / 2}
          y2={element.height}
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          strokeLinecap="round"
          shapeRendering="geometricPrecision"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }
  if (thinY) {
    return (
      <svg width={svgWidth} height={svgHeight} style={{ overflow: 'visible' }}>
        <line
          x1={0}
          y1={element.height / 2}
          x2={element.width}
          y2={element.height / 2}
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          strokeLinecap="round"
          shapeRendering="geometricPrecision"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }
  return (
    <svg width={svgWidth} height={svgHeight} style={{ overflow: 'visible' }}>
      <ellipse
        cx={element.width / 2}
        cy={element.height / 2}
        rx={element.width / 2}
        ry={element.height / 2}
        fill={element.fill}
        stroke={element.stroke}
        strokeWidth={element.strokeWidth}
        strokeLinejoin="round"
        shapeRendering="geometricPrecision"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
function rotateAround(point: Point, center: Point, angle: number) {
  const dx = point.x - center.x
  const dy = point.y - center.y
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }
}
const hitsElementWithCircle = (point: Point, element: BoardElement, radius: number) => {
  const closestX = Math.max(element.x, Math.min(point.x, element.x + element.width))
  const closestY = Math.max(element.y, Math.min(point.y, element.y + element.height))
  return distance(point, { x: closestX, y: closestY }) <= radius
}
const pointToSegmentDistance = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return distance(point, start)
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1)
  return distance(point, {
    x: start.x + dx * t,
    y: start.y + dy * t,
  })
}
const getCompassLocalGeometry = (spread: number) => {
  const leftTip = COMPASS_LEFT_TIP
  const openAngle = getCompassAngleForSpread(spread)
  const rightAbsoluteAngle = COMPASS_LEFT_ABSOLUTE_ANGLE - openAngle
  const openRotation = rightAbsoluteAngle - COMPASS_RIGHT_BASE_ABSOLUTE_ANGLE
  const rightStart = rotateAround(COMPASS_RIGHT_START, COMPASS_HINGE, openRotation)
  const rightTip = rotateAround(COMPASS_RIGHT_TIP_BASE, COMPASS_HINGE, openRotation)
  const hinge = COMPASS_HANDLE_CENTER
  const leftStart = COMPASS_LEFT_START
  const baseDrawAngle = normalizeAngle(radiansToDegrees(Math.atan2(rightTip.y - leftTip.y, rightTip.x - leftTip.x)))
  const handleAngle = normalizeAngle(radiansToDegrees(Math.atan2(hinge.y - leftTip.y, hinge.x - leftTip.x)))
  const drawCenter = leftTip
  const drawRadius = distance(leftTip, rightTip)
  const drawTip = rightTip
  return {
    hinge,
    leftStart,
    leftTip,
    rightStart,
    rightTip,
    drawCenter,
    drawRadius,
    drawTip,
    openAngle,
    rightAbsoluteAngle,
    baseDrawAngle,
    handleAngle,
  }
}
const getCompassGeometry = (element: Extract<BoardElement, { type: 'compass' }>) => {
  const local = getCompassLocalGeometry(element.radius)
  const drawRotation = degreesToRadians(signedAngleDelta(element.endAngle, local.baseDrawAngle))
  const rotatedHinge = rotateAround(local.hinge, local.leftTip, drawRotation)
  const rotatedLeftStart = rotateAround(local.leftStart, local.leftTip, drawRotation)
  const rotatedRightStart = rotateAround(local.rightStart, local.leftTip, drawRotation)
  const rotatedRightTip = rotateAround(local.rightTip, local.leftTip, drawRotation)
  const hinge = { x: element.x + rotatedHinge.x, y: element.y + rotatedHinge.y }
  const leftStart = { x: element.x + rotatedLeftStart.x, y: element.y + rotatedLeftStart.y }
  const leftTip = { x: element.x + local.leftTip.x, y: element.y + local.leftTip.y }
  const rightStart = { x: element.x + rotatedRightStart.x, y: element.y + rotatedRightStart.y }
  const rightTip = { x: element.x + rotatedRightTip.x, y: element.y + rotatedRightTip.y }
  const drawCenter = { x: element.x + local.drawCenter.x, y: element.y + local.drawCenter.y }
  const drawRadius = local.drawRadius
  const drawTip = { x: rightTip.x, y: rightTip.y }
  const handleAngle = normalizeAngle(radiansToDegrees(Math.atan2(hinge.y - drawCenter.y, hinge.x - drawCenter.x)))
  return { hinge, leftStart, leftTip, rightStart, rightTip, drawCenter, drawRadius, drawTip, handleAngle, baseDrawAngle: local.baseDrawAngle }
}
const getCompassHitZone = (element: Extract<BoardElement, { type: 'compass' }>, point: Point) => {
  const { hinge, leftStart, leftTip, rightStart, rightTip } = getCompassGeometry(element)
  if (distance(point, hinge) <= 30) return 'handle' as const
  if (distance(point, rightTip) <= 28 || pointToSegmentDistance(point, rightStart, rightTip) <= 18) return 'pen' as const
  if (
    distance(point, leftTip) <= 24 ||
    pointToSegmentDistance(point, leftStart, leftTip) <= 18 ||
    pointToSegmentDistance(point, hinge, leftStart) <= 20 ||
    pointToSegmentDistance(point, hinge, rightStart) <= 20 ||
    distance(point, {
      x: (hinge.x + leftTip.x + rightTip.x) / 3,
      y: (hinge.y + leftTip.y + rightTip.y) / 3,
    }) <= 36
  ) {
    return 'body' as const
  }
  return null
}
const getRotateHandlePoint = (element: Exclude<BoardElement, { type: 'pen' | 'compass' }>) => {
  const center = { x: element.x + element.width / 2, y: element.y + element.height / 2 }
  const handle = { x: element.x + element.width / 2, y: element.y - 16 }
  if (!element.rotation) return handle
  return rotateAround(handle, center, degreesToRadians(element.rotation))
}
const isMonacoElement = (element: BoardElement): element is MonacoElement => element.type === 'monaco'
const isCodeElement = (element: BoardElement): element is CodeElement => element.type === 'code'
const isEditableTextElement = (element: BoardElement): element is Extract<BoardElement, { type: 'text' | 'markdown' }> =>
  element.type === 'text' || element.type === 'markdown'
const elementBoundsHit = (element: BoardElement, point: Point) => {
  if (element.type === 'compass') {
    return getCompassHitZone(element, point) !== null
  }
  return (
    point.x >= element.x &&
    point.x <= element.x + element.width &&
    point.y >= element.y &&
    point.y <= element.y + element.height
  )
}
const isSelectableElement = (element: BoardElement) => element.type !== 'pen'
const compareElementStack = (a: BoardElement, b: BoardElement) => {
  if (a.type === 'compass' && b.type !== 'compass') return 1
  if (a.type !== 'compass' && b.type === 'compass') return -1
  return a.zIndex - b.zIndex
}
const sortByZ = (elements: BoardElement[]) => [...elements].sort((a, b) => compareElementStack(b, a))
const getNextZIndex = (elements: BoardElement[]) =>
  elements.reduce((max, element) => Math.max(max, element.zIndex), 0) + 1
const getRenderZIndex = (element: BoardElement, maxZIndex: number) =>
  element.type === 'compass' ? maxZIndex + 1000 + element.zIndex : element.zIndex

export function WhiteboardPage() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const penCanvasRef = useRef<HTMLCanvasElement>(null)
  const assetInputRef = useRef<HTMLInputElement>(null)
  const editingTextRef = useRef<HTMLTextAreaElement | null>(null)
  const chatWindowRef = useRef<HTMLDivElement | null>(null)
  const elementsRef = useRef<BoardElement[]>([])
  const dragRef = useRef<DragState>(null)
  const boardUpdatedAtRef = useRef('')
  const saveTimerRef = useRef<number | null>(null)
  const eraserSessionRef = useRef<BoardElement[] | null>(null)
  const eraserPointsRef = useRef<Point[]>([])
  const modalTextResolverRef = useRef<((value: string | null) => void) | null>(null)
  const modalConfirmResolverRef = useRef<((value: boolean) => void) | null>(null)

  const [boards, setBoards] = useState<Board[]>([])
  const [activeBoardId, setActiveBoardId] = useState('')
  const [elements, setElements] = useState<BoardElement[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [tool, setTool] = useState<CanvasToolId>('select')
  const [viewport, setViewport] = useState<Viewport>(boardCenter)
  const [draft, setDraft] = useState<DraftState>(null)
  const [drag, setDrag] = useState<DragState>(null)
  const [history, setHistory] = useState<BoardElement[][]>([])
  const [future, setFuture] = useState<BoardElement[][]>([])
  const [openToolCategory, setOpenToolCategory] = useState<ToolCategory | null>(null)
  const [aiOpen, setAiOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('ai')
  const [agentMode, setAgentMode] = useState<AgentMode>('chat')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [agentLoading, setAgentLoading] = useState(false)
  const [aiSettings, setAiSettings] = useState<AIProviderSettings>(defaultAISettings)
  const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>(() => {
    if (typeof window === 'undefined') return defaultProviderPresets
    return parseProviderPresets(window.localStorage.getItem(AI_PROVIDER_LIST_STORAGE_KEY))
  })
  const [modelPresets, setModelPresets] = useState<ModelPreset[]>(() => {
    if (typeof window === 'undefined') return defaultModelPresets
    return parseModelPresets(window.localStorage.getItem(AI_MODEL_LIST_STORAGE_KEY))
  })
  const [selectedChatModelId, setSelectedChatModelId] = useState(defaultModelPresets[0]?.id ?? '')
  const [pendingAssetKind, setPendingAssetKind] = useState<Asset['kind'] | null>(null)
  const [pendingAsset, setPendingAsset] = useState<Asset | null>(null)
  const [statusMessage, setStatusMessage] = useState('Loading workspace...')
  const [modal, setModal] = useState<ModalState>(null)
  const [modalInput, setModalInput] = useState('')
  const [penColor, setPenColor] = useState(DEFAULT_PEN_COLOR)
  const [penStrokeWidth, setPenStrokeWidth] = useState(DEFAULT_PEN_STROKE_WIDTH)
  const [shapeColor, setShapeColor] = useState(DEFAULT_SHAPE_COLOR)
  const [shapeStrokeWidth, setShapeStrokeWidth] = useState(DEFAULT_SHAPE_STROKE_WIDTH)
  const [shapeFilled, setShapeFilled] = useState(DEFAULT_SHAPE_FILLED)
  const [eraserRadius, setEraserRadius] = useState(DEFAULT_ERASER_RADIUS)
  const [eraserPenOnly, setEraserPenOnly] = useState(false)
  const [eraserPointer, setEraserPointer] = useState<Point | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [codeLanguage, setCodeLanguage] = useState('javascript')

  const activeBoard = useMemo(
    () => boards.find((board) => board.id === activeBoardId) ?? null,
    [boards, activeBoardId],
  )
  const selectedChatModel = useMemo(
    () => modelPresets.find((model) => model.id === selectedChatModelId) ?? null,
    [modelPresets, selectedChatModelId],
  )

  const selectedChatProvider = useMemo(
    () => providerPresets.find((provider) => provider.id === selectedChatModel?.providerId) ?? null,
    [providerPresets, selectedChatModel],
  )
  const commitElements = (nextElements: BoardElement[], pushHistory = true) => {
    const previousElements = elementsRef.current
    elementsRef.current = nextElements
    setElements(nextElements)
    if (pushHistory) {
      setHistory((prev) => [...prev.slice(-60), previousElements])
      setFuture([])
    }
  }

  const syncBoardVersion = (updatedAt: string) => {
    boardUpdatedAtRef.current = updatedAt
  }

  const runSave = (boardId: string, nextElements: BoardElement[]) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        const saved = await api.saveElements(boardId, nextElements, boardUpdatedAtRef.current || undefined)
        syncBoardVersion(saved.updatedAt)
        setBoards((prev) => prev.map((board) => (board.id === saved.id ? saved : board)))
        if (activeBoardId === saved.id) {
          const currentJson = JSON.stringify(nextElements)
          const savedJson = JSON.stringify(saved.elements)
          if (currentJson !== savedJson) {
            setElements(saved.elements)
          }
        }
        setStatusMessage('Saved')
      } catch (error) {
        setStatusMessage(error instanceof Error ? `Save failed: ${error.message}` : 'Save failed')
      }
    }, 420)
  }

  const openTextModal = (config: Omit<TextModalConfig, 'kind'>) =>
    new Promise<string | null>((resolve) => {
      modalTextResolverRef.current = resolve
      setModalInput(config.initialValue)
      setModal({
        kind: 'text',
        ...config,
      })
    })

  const openConfirmModal = (config: Omit<ConfirmModalConfig, 'kind'>) =>
    new Promise<boolean>((resolve) => {
      modalConfirmResolverRef.current = resolve
      setModal({
        kind: 'confirm',
        ...config,
      })
    })

  const closeModal = () => {
    setModal(null)
    setModalInput('')
  }

  const confirmTextModal = () => {
    modalTextResolverRef.current?.(modalInput.trim() || null)
    modalTextResolverRef.current = null
    closeModal()
  }

  const cancelTextModal = () => {
    modalTextResolverRef.current?.(null)
    modalTextResolverRef.current = null
    closeModal()
  }

  const confirmConfirmModal = () => {
    modalConfirmResolverRef.current?.(true)
    modalConfirmResolverRef.current = null
    closeModal()
  }

  const cancelConfirmModal = () => {
    modalConfirmResolverRef.current?.(false)
    modalConfirmResolverRef.current = null
    closeModal()
  }

  useEffect(() => {
    void (async () => {
      try {
        const [boardList, settings] = await Promise.all([api.listBoards(), api.getAISettings()])
        const board = boardList[0]
        setBoards(boardList)
        setActiveBoardId(board.id)
        setElements(board.elements)
        syncBoardVersion(board.updatedAt)
        setAiSettings(settings)
        setProviderPresets((prev) =>
          prev.map((provider) =>
            provider.providerType === settings.providerType
              ? {
                  ...provider,
                  apiKey: provider.apiKey || settings.apiKey,
                  baseUrl: settings.providerType === 'compatible' ? settings.baseUrl || provider.baseUrl : provider.baseUrl,
                }
              : provider,
          ),
        )
        setSelectedChatModelId((prev) => {
          if (prev && modelPresets.some((item) => item.id === prev)) return prev
          const matched = modelPresets.find((item) => item.modelId === settings.modelId)
          return matched?.id ?? modelPresets[0]?.id ?? ''
        })
        setAssets(await api.listAssets(board.id))
        setStatusMessage('Workspace ready')
      } catch (error) {
        setStatusMessage(error instanceof Error ? `Failed to load: ${error.message}` : 'Failed to load')
      }
    })()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(AI_PROVIDER_LIST_STORAGE_KEY, JSON.stringify(providerPresets))
  }, [providerPresets])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(AI_MODEL_LIST_STORAGE_KEY, JSON.stringify(modelPresets))
  }, [modelPresets])

  useEffect(() => {
    if (modelPresets.length === 0) {
      setSelectedChatModelId('')
      return
    }
    if (!modelPresets.some((item) => item.id === selectedChatModelId)) {
      setSelectedChatModelId(modelPresets[0].id)
    }
  }, [modelPresets, selectedChatModelId])

  useEffect(() => {
    if (!aiSettings.modelId) return
    const matched = modelPresets.find((item) => item.modelId === aiSettings.modelId)
    if (!matched) return
    setSelectedChatModelId((prev) => (prev === matched.id ? prev : matched.id))
  }, [aiSettings.modelId, modelPresets])

  useEffect(() => {
    if (!activeBoardId) return
    runSave(activeBoardId, elements)
    setBoards((prev) =>
      prev.map((board) =>
        board.id === activeBoardId ? { ...board, elements, updatedAt: new Date().toISOString() } : board,
      ),
    )
  }, [elements, activeBoardId])

  useEffect(() => {
    elementsRef.current = elements
  }, [elements])

  useEffect(() => {
    dragRef.current = drag
  }, [drag])

  useEffect(() => {
    if (!editingTextId) return
    window.requestAnimationFrame(() => {
      const input = editingTextRef.current
      if (!input) return
      input.focus()
      const end = input.value.length
      input.setSelectionRange(end, end)
    })
  }, [editingTextId, elements])

  useEffect(() => {
    const node = chatWindowRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [chatMessages])

  const screenToWorld = (clientX: number, clientY: number): Point => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: viewport.x + (clientX - rect.left) / viewport.zoom, y: viewport.y + (clientY - rect.top) / viewport.zoom }
  }
  const eventToWorldPoints = (event: React.PointerEvent<HTMLDivElement>) => {
    const native = event.nativeEvent
    const coalesced = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
    if (coalesced.length > 0) {
      return coalesced.map((sample) => screenToWorld(sample.clientX, sample.clientY))
    }
    return [screenToWorld(event.clientX, event.clientY)]
  }

  const topElementAt = (point: Point) =>
    sortByZ(elements).find((element) => isSelectableElement(element) && elementBoundsHit(element, point))
  const eraseAtPoints = (source: BoardElement[], points: Point[]) => {
    if (points.length === 0) return source
    const next = source.filter(
      (element) =>
        !points.some(
          (point) =>
            (!eraserPenOnly || element.type === 'pen') &&
            hitsElementWithCircle(point, element, eraserRadius),
        ),
    )
    return next.map((element, index) => ({ ...element, zIndex: index + 1 }))
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // ignore capture errors
    }
    const samples = eventToWorldPoints(event)
    const point = samples[samples.length - 1]
    if (tool === 'eraser-stroke') {
      setEraserPointer(point)
    }
    if (event.button === 1) {
      const nextDrag: DragState = { kind: 'canvas', start: { x: event.clientX, y: event.clientY }, origin: { x: viewport.x, y: viewport.y } }
      dragRef.current = nextDrag
      setDrag(nextDrag)
      return
    }
    if (tool === 'select') {
      const selectedElement =
        selectedElementId != null
          ? elements.find((element) => element.id === selectedElementId) ?? null
          : null
      if (selectedElement && selectedElement.type !== 'pen' && selectedElement.type !== 'compass') {
        const rotateHandle = getRotateHandlePoint(selectedElement)
        if (distance(point, rotateHandle) <= 14) {
          const center = { x: selectedElement.x + selectedElement.width / 2, y: selectedElement.y + selectedElement.height / 2 }
          const startAngle =
            (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI
          const nextDrag: DragState = {
            kind: 'rotate',
            elementId: selectedElement.id,
            center,
            startAngle,
            originalRotation: selectedElement.rotation,
            original: selectedElement,
          }
          dragRef.current = nextDrag
          setDrag(nextDrag)
          return
        }
      }
      const hit = topElementAt(point)
      if (!hit) {
        setSelectedElementId(null)
        const nextDrag: DragState = { kind: 'canvas', start: { x: event.clientX, y: event.clientY }, origin: { x: viewport.x, y: viewport.y } }
        dragRef.current = nextDrag
        setDrag(nextDrag)
        return
      }
      setSelectedElementId(hit.id)
      if (hit.type === 'compass') {
        const hitZone = getCompassHitZone(hit, point)
        const { hinge, drawCenter, drawRadius, drawTip, handleAngle } = getCompassGeometry(hit)
        if (hitZone === 'handle') {
          const nextDrag: DragState = {
            kind: 'compass-draw',
            elementId: hit.id,
            center: drawCenter,
            radius: drawRadius,
            handleRadius: distance(drawCenter, hinge),
            angleOffset: signedAngleDelta(hit.endAngle, handleAngle),
            stroke: hit.stroke,
            strokeWidth: clamp(hit.strokeWidth, 1, 8),
            points: [drawTip],
            startContinuousAngle: hit.endAngle,
            minContinuousAngle: hit.endAngle,
            maxContinuousAngle: hit.endAngle,
            continuousAngle: hit.endAngle,
            endAngle: hit.endAngle,
          }
          dragRef.current = nextDrag
          setDrag(nextDrag)
          return
        }
        if (hitZone === 'pen') {
          const nextDrag: DragState = {
            kind: 'compass-radius',
            elementId: hit.id,
            center: hinge,
            original: hit,
          }
          dragRef.current = nextDrag
          setDrag(nextDrag)
          return
        }
        const nextDrag: DragState = { kind: 'move', elementId: hit.id, start: point, original: hit }
        dragRef.current = nextDrag
        setDrag(nextDrag)
        return
      }
      const resizeHandleHit = Math.abs(point.x - (hit.x + hit.width)) < 18 && Math.abs(point.y - (hit.y + hit.height)) < 18
      const canResize = hit.type !== 'ruler'
      const rotateHandleHit =
        hit.type !== 'pen' &&
        distance(point, getRotateHandlePoint(hit)) <= 14
      if (rotateHandleHit) {
        const center = { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 }
        const startAngle =
          (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI
        const nextDrag: DragState = {
          kind: 'rotate',
          elementId: hit.id,
          center,
          startAngle,
          originalRotation: hit.rotation,
          original: hit,
        }
        dragRef.current = nextDrag
        setDrag(nextDrag)
        return
      }
      const nextDrag: DragState =
        resizeHandleHit && canResize
          ? { kind: 'resize', elementId: hit.id, start: point, original: hit }
          : { kind: 'move', elementId: hit.id, start: point, original: hit }
      dragRef.current = nextDrag
      setDrag(nextDrag)
      return
    }
    if (tool === 'pen') return setDraft({ type: 'pen', rawPoints: [point], points: [point] })
    if (tool === 'eraser-stroke') {
      eraserSessionRef.current = elements
      eraserPointsRef.current = [point]
      setDraft({ type: 'eraser', points: [point] })
      setElements(eraseAtPoints(elements, eraserPointsRef.current))
      return
    }
    if (tool === 'compass') {
      const placed = createPlacedElement('compass', point, getNextZIndex(elements))
      const styledPlaced =
        placed.type === 'compass'
          ? {
              ...placed,
              stroke: penColor,
              strokeWidth: clamp(penStrokeWidth, 1, 8),
              updatedAt: new Date().toISOString(),
            }
          : placed
      commitElements([...elements, styledPlaced])
      setSelectedElementId(styledPlaced.id)
      setTool('select')
      return
    }
    if (tool === 'text' || tool === 'markdown') {
      const placed = createPlacedElement(tool, point, getNextZIndex(elements))
      if (!isEditableTextElement(placed)) return
      commitElements([...elements, placed])
      setSelectedElementId(placed.id)
      setEditingTextId(placed.id)
      setTool('select')
      return
    }
    if (tool === 'code') {
      const placed = createPlacedElement('code', point, getNextZIndex(elements))
      const nextPlaced =
        placed.type === 'code'
          ? {
              ...placed,
              language: codeLanguage,
              updatedAt: new Date().toISOString(),
            }
          : placed
      commitElements([...elements, nextPlaced])
      setSelectedElementId(nextPlaced.id)
      setTool('select')
      return
    }
    if (tool === 'monaco') {
      const placed = createPlacedElement('monaco', point, getNextZIndex(elements))
      const nextPlaced =
        placed.type === 'monaco'
          ? {
              ...placed,
              language: codeLanguage,
              updatedAt: new Date().toISOString(),
            }
          : placed
      commitElements([...elements, nextPlaced])
      setSelectedElementId(nextPlaced.id)
      setTool('select')
      return
    }
    if (tool === 'line' || tool === 'arrow' || tool === 'rectangle' || tool === 'ellipse') {
      return setDraft({ type: 'shape', tool, start: point, end: point })
    }
    if (tool === 'iframe') {
      void (async () => {
        const src = await openTextModal({
          title: 'Embed URL',
          message: 'Paste an iframe or video embed URL.',
          placeholder: 'https://...',
          initialValue: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
          confirmLabel: 'Insert',
        })
        if (!src) return
        const element = createPlacedElement('iframe', point, getNextZIndex(elements), {
          src,
          title: 'Embedded frame',
        })
        commitElements([...elements, element]); setSelectedElementId(element.id)
      })()
      return
    }
    if (tool === 'latex') {
      void (async () => {
        const latex = await openTextModal({
          title: 'Insert LaTeX',
          message: 'Enter a LaTeX expression.',
          placeholder: 'f(x)=x^2+3x+2',
          initialValue: 'f(x)=x^2+3x+2',
          confirmLabel: 'Insert',
        })
        if (!latex) return
        const base = createPlacedElement('latex', point, getNextZIndex(elements))
        if (base.type !== 'latex') return
        const element = {
          ...base,
          latex,
          width: Math.max(96, Math.round(28 * (Math.max(3, latex.replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}_^]/g, '').replace(/\s+/g, '').length) * 0.62 + 1.8))),
          height: Math.max(52, Math.round(28 * 2.2)),
          updatedAt: new Date().toISOString(),
        }
        commitElements([...elements, element])
        setSelectedElementId(element.id)
      })()
      return
    }
    if (tool === 'image' || tool === 'video' || tool === 'file') {
      if (!pendingAsset || pendingAsset.kind !== tool) return setStatusMessage(`Upload a ${tool} asset first.`)
      const element = createPlacedElement(tool, point, getNextZIndex(elements), { asset: pendingAsset })
      commitElements([...elements, element]); setSelectedElementId(element.id); setPendingAsset(null); return
    }
    const placed = createPlacedElement(tool, point, getNextZIndex(elements))
    commitElements([...elements, placed]); setSelectedElementId(placed.id)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const samples = eventToWorldPoints(event)
    const point = samples[samples.length - 1]
    const activeDrag = dragRef.current
    if (tool === 'eraser-stroke' || draft?.type === 'eraser') {
      setEraserPointer(point)
    }
    if (tool === 'eraser-stroke' && (event.buttons & 1) === 1) {
      if (!eraserSessionRef.current) {
        eraserSessionRef.current = elements
      }
      eraserPointsRef.current = [...eraserPointsRef.current, point]
      setDraft((prev) =>
        prev?.type === 'eraser'
          ? { ...prev, points: [...prev.points, point] }
          : { type: 'eraser', points: [point] },
      )
      const source = eraserSessionRef.current ?? elements
      setElements(eraseAtPoints(source, eraserPointsRef.current))
      return
    }
    if (draft?.type === 'shape') return setDraft({ ...draft, end: point })
    if (draft?.type === 'pen') {
      return setDraft((prev) => {
        if (prev?.type !== 'pen') return prev
        const nextRawPoints = [...prev.rawPoints]
        const nextSmoothPoints = [...prev.points]
        let lastRaw = nextRawPoints[nextRawPoints.length - 1]
        let lastSmooth = nextSmoothPoints[nextSmoothPoints.length - 1]
        if (!lastRaw || !lastSmooth) return prev
        for (const sample of samples) {
          if (distance(lastRaw, sample) < PEN_MIN_POINT_DISTANCE) {
            continue
          }
          const stabilized = stabilizePenSample(lastRaw, lastSmooth, sample)
          nextRawPoints.push(sample)
          nextSmoothPoints.push(stabilized)
          lastRaw = sample
          lastSmooth = stabilized
        }
        if (nextSmoothPoints.length === prev.points.length) return prev
        return { ...prev, rawPoints: nextRawPoints, points: nextSmoothPoints }
      })
    }
    if (draft?.type === 'eraser') {
      eraserPointsRef.current = [...eraserPointsRef.current, point]
      setDraft((prev) => (prev?.type === 'eraser' ? { ...prev, points: [...prev.points, point] } : prev))
      const source = eraserSessionRef.current ?? elements
      setElements(eraseAtPoints(source, eraserPointsRef.current))
      return
    }
    if (activeDrag?.kind === 'canvas') {
      const dx = (event.clientX - activeDrag.start.x) / viewport.zoom
      const dy = (event.clientY - activeDrag.start.y) / viewport.zoom
      return setViewport((prev) => ({ ...prev, x: activeDrag.origin.x - dx, y: activeDrag.origin.y - dy }))
    }
    if (activeDrag?.kind === 'move') {
      const dx = point.x - activeDrag.start.x
      const dy = point.y - activeDrag.start.y
      return setElements((prev) => {
        const next = prev.map((element) => (element.id === activeDrag.elementId ? translateElement(activeDrag.original, dx, dy) : element))
        elementsRef.current = next
        return next
      })
    }
    if (activeDrag?.kind === 'compass-radius') {
      const leftTip = {
        x: activeDrag.original.x + COMPASS_LEFT_TIP.x,
        y: activeDrag.original.y + COMPASS_LEFT_TIP.y,
      }
      const nextRadius = clamp(distance(leftTip, point), COMPASS_MIN_SPREAD, COMPASS_MAX_SPREAD)
      return setElements((prev) => {
        const next = prev.map((element) =>
          element.id === activeDrag.elementId && element.type === 'compass'
            ? {
                ...element,
                radius: nextRadius,
                updatedAt: new Date().toISOString(),
              }
            : element,
        )
        elementsRef.current = next
        return next
      })
    }
    if (activeDrag?.kind === 'rotate') {
      const currentAngle =
        (Math.atan2(point.y - activeDrag.center.y, point.x - activeDrag.center.x) * 180) /
        Math.PI
      const delta = currentAngle - activeDrag.startAngle
      setElements((prev) => {
        const next = prev.map((element) =>
          element.id === activeDrag.elementId
            ? updateElement(activeDrag.original, {
                rotation: activeDrag.originalRotation + delta,
              })
            : element,
        )
        elementsRef.current = next
        return next
      })
      return
    }
    if (activeDrag?.kind === 'compass-draw') {
      let currentAngle = activeDrag.continuousAngle
      let minAngle = activeDrag.minContinuousAngle
      let maxAngle = activeDrag.maxContinuousAngle
      for (const sample of samples) {
        if (distance(sample, activeDrag.center) < activeDrag.handleRadius * 0.45) {
          continue
        }
        const rawAngle = getCompassAngleFromHandle(activeDrag.center, activeDrag.angleOffset, sample)
        const nextAngle = unwrapCompassAngle(rawAngle, currentAngle)
        currentAngle = nextAngle
        minAngle = Math.min(minAngle, nextAngle)
        maxAngle = Math.max(maxAngle, nextAngle)
      }
      const arcPoints = buildCompassArcPoints(
        activeDrag.center,
        activeDrag.radius,
        minAngle,
        maxAngle,
      )
      const normalizedEndAngle = normalizeAngle(currentAngle)
      setElements((prev) => {
        const next = prev.map((element) =>
          element.id === activeDrag.elementId && element.type === 'compass'
            ? {
                ...element,
                endAngle: normalizedEndAngle,
                updatedAt: new Date().toISOString(),
              }
            : element,
        )
        elementsRef.current = next
        return next
      })
      setDrag((prev) =>
        prev?.kind === 'compass-draw'
          ? (() => {
              const nextDrag: DragState = {
                ...prev,
                points: arcPoints,
                minContinuousAngle: minAngle,
                maxContinuousAngle: maxAngle,
                continuousAngle: currentAngle,
                endAngle: normalizedEndAngle,
              }
              dragRef.current = nextDrag
              return nextDrag
            })()
          : prev,
      )
      return
    }
    if (activeDrag?.kind === 'resize') {
      const width = activeDrag.original.width + (point.x - activeDrag.start.x)
      const height = activeDrag.original.height + (point.y - activeDrag.start.y)
      setElements((prev) => {
        const next = prev.map((element) => (element.id === activeDrag.elementId ? resizeElement(activeDrag.original, width, height) : element))
        elementsRef.current = next
        return next
      })
    }
  }

  const onPointerUp = (event?: React.PointerEvent<HTMLDivElement>) => {
    const activeDrag = dragRef.current
    if (event) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      } catch {
        // ignore release errors
      }
    }
    if (draft?.type === 'shape') {
      const shape = createShapeElement(draft.tool, draft.start, draft.end, getNextZIndex(elements), {
        stroke: shapeColor,
        fill:
          draft.tool === 'rectangle' || draft.tool === 'ellipse'
            ? shapeFilled
              ? getShapeFillColor(shapeColor)
              : 'transparent'
            : 'transparent',
      })
      shape.strokeWidth = shapeStrokeWidth
      commitElements([...elements, shape]); setSelectedElementId(null)
    } else if (draft?.type === 'pen' && draft.points.length > 1) {
      const pen = createPenElement(draft.points, getNextZIndex(elements), {
        stroke: penColor,
        strokeWidth: penStrokeWidth,
      })
      commitElements([...elements, pen]); setSelectedElementId(null)
    } else if (draft?.type === 'eraser') {
      if (eraserSessionRef.current && eraserSessionRef.current !== elements) {
        setHistory((prev) => [...prev.slice(-60), eraserSessionRef.current!])
        setFuture([])
      }
      eraserSessionRef.current = null
      eraserPointsRef.current = []
    } else if (activeDrag?.kind === 'compass-draw') {
      // Keep the final compass endAngle on pointer release.
      const currentElements = elementsRef.current
      const updatedElements = currentElements.map((element) =>
        element.id === activeDrag.elementId && element.type === 'compass'
          ? {
              ...element,
              endAngle: activeDrag.endAngle,
              updatedAt: new Date().toISOString(),
            }
          : element,
      )
      if (activeDrag.points.length > 1) {
        const stroke = createPenElement(activeDrag.points, getNextZIndex(updatedElements))
        const styledStroke = {
          ...stroke,
          stroke: activeDrag.stroke,
          strokeWidth: activeDrag.strokeWidth,
        }
        commitElements([...updatedElements, styledStroke])
        setSelectedElementId(activeDrag.elementId)
      } else {
        commitElements(updatedElements)
      }
    } else if (
      activeDrag?.kind === 'move' ||
      activeDrag?.kind === 'compass-radius' ||
      activeDrag?.kind === 'resize' ||
      activeDrag?.kind === 'rotate'
    ) {
      commitElements(elementsRef.current)
    }
    dragRef.current = null
    setDraft(null); setDrag(null)
  }

  const onPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerUp(event)
    setEraserPointer(null)
  }

  const zoomBy = (factor: number) => setViewport((prev) => ({ ...prev, zoom: Math.min(2.6, Math.max(0.2, prev.zoom * factor)) }))
  const resetView = () => setViewport(boardCenter())
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoomBy(event.deltaY > 0 ? 0.95 : 1.05) }
  }

  const undo = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((items) => items.slice(0, -1))
    setFuture((items) => [elements, ...items].slice(0, 60))
    setElements(prev)
    setSelectedElementId(null)
  }
  const redo = () => {
    if (future.length === 0) return
    const [next, ...rest] = future
    setHistory((items) => [...items, elements].slice(-60))
    setFuture(rest)
    setElements(next)
    setSelectedElementId(null)
  }

  const createBoardAction = async () => {
    const name = await openTextModal({
      title: 'Create Board',
      message: 'Enter a board name.',
      placeholder: 'Board name',
      initialValue: `Board ${boards.length + 1}`,
      confirmLabel: 'Create',
    })
    if (!name) return
    if (!name) return
    const board = await api.createBoard(name)
    setBoards((prev) => [board, ...prev])
    setActiveBoardId(board.id)
    setElements([])
    syncBoardVersion(board.updatedAt)
    setHistory([])
    setFuture([])
    setSelectedElementId(null)
    setAssets([])
    setStatusMessage('Board created')
  }

  const renameBoardAction = async () => {
    if (!activeBoard) return
    const name = await openTextModal({
      title: 'Rename Board',
      message: 'Update the board name.',
      placeholder: 'Board name',
      initialValue: activeBoard.name,
      confirmLabel: 'Rename',
    })
    if (!name) return
    const board = await api.updateBoard(activeBoard.id, name)
    setBoards((prev) => prev.map((item) => (item.id === board.id ? board : item)))
    setStatusMessage('Board renamed')
  }

  const deleteBoardAction = async () => {
    if (!activeBoard) return
    const confirmed = await openConfirmModal({
      title: 'Delete Board',
      message: `Delete "${activeBoard.name}" permanently?`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    await api.deleteBoard(activeBoard.id)
    const remaining = boards.filter((board) => board.id !== activeBoard.id)
    if (remaining.length === 0) {
      const seeded = await api.createBoard('New board')
      setBoards([seeded])
      setActiveBoardId(seeded.id)
      setElements([])
      syncBoardVersion(seeded.updatedAt)
      setAssets([])
    } else {
      setBoards(remaining)
      setActiveBoardId(remaining[0].id)
      setElements(remaining[0].elements)
      syncBoardVersion(remaining[0].updatedAt)
      setAssets(await api.listAssets(remaining[0].id))
    }
    setSelectedElementId(null)
    setHistory([])
    setFuture([])
    setStatusMessage('Board deleted')
  }

  const switchBoard = async (boardId: string) => {
    if (boardId === activeBoardId) return
    const board = await api.getBoard(boardId)
    setActiveBoardId(board.id)
    setElements(board.elements)
    syncBoardVersion(board.updatedAt)
    setSelectedElementId(null)
    setHistory([])
    setFuture([])
    setAssets(await api.listAssets(board.id))
    setStatusMessage(`Opened "${board.name}"`)
  }

  const clearAllElements = async () => {
    if (elements.length === 0) return
    const confirmed = await openConfirmModal({
      title: 'Clear all elements?',
      message: 'This will remove every element on the current board.',
      confirmLabel: 'Clear All',
      danger: true,
    })
    if (!confirmed) return
    commitElements([])
    setSelectedElementId(null)
    setStatusMessage('Board cleared')
  }

  const saveNow = async () => {
    if (!activeBoardId) return
    const saved = await api.saveElements(activeBoardId, elements, boardUpdatedAtRef.current || undefined)
    syncBoardVersion(saved.updatedAt)
    setBoards((prev) => prev.map((board) => (board.id === saved.id ? saved : board)))
    setElements(saved.elements)
    setStatusMessage('Saved now')
  }

  const openAssetPicker = (kind: Asset['kind']) => {
    if (!activeBoardId) {
      setStatusMessage('Open a board first.')
      return
    }
    setPendingAssetKind(kind)
    assetInputRef.current?.click()
  }

  const handleToolSelect = (nextTool: CanvasToolId) => {
    setEditingTextId(null)
    if (nextTool === 'image' || nextTool === 'video' || nextTool === 'file') {
      setTool(nextTool)
      setPendingAsset(null)
      openAssetPicker(nextTool)
      return
    }
    setTool(nextTool)
  }
  const toggleToolCategory = (category: ToolCategory) => {
    setOpenToolCategory((prev) => (prev === category ? null : category))
  }

  const onAssetFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !activeBoardId || !pendingAssetKind) return
    try {
      const asset = await api.uploadAsset(activeBoardId, pendingAssetKind, file)
      setAssets((prev) => [asset, ...prev])
      setPendingAsset(asset)
      setTool(pendingAssetKind)
      setStatusMessage(`Uploaded ${asset.name}. Click canvas to place it.`)
    } catch (error) {
      setStatusMessage(error instanceof Error ? `Upload failed: ${error.message}` : 'Upload failed')
    }
    event.currentTarget.value = ''
  }

  const buildSelectedAISettings = () => {
    if (!selectedChatModel || !selectedChatProvider) return null
    return {
      ...aiSettings,
      providerType: selectedChatProvider.providerType,
      apiKey: selectedChatProvider.apiKey,
      providerName: selectedChatProvider.name.trim() || 'AI Provider',
      baseUrl: selectedChatProvider.baseUrl,
      modelName: selectedChatModel.name.trim() || selectedChatModel.modelId,
      modelId: selectedChatModel.modelId.trim(),
    } satisfies AIProviderSettings
  }

  const saveAISettingsAction = async (nextSettings?: AIProviderSettings) => {
    const target = nextSettings ?? aiSettings
    const saved = await api.saveAISettings(target)
    setAiSettings(saved)
    setStatusMessage('AI settings saved')
    return saved
  }

  const addProviderPreset = () => {
    setProviderPresets((prev) => [
      ...prev,
      {
        id: createLocalId('provider'),
        name: 'New Provider',
        providerType: 'compatible',
        baseUrl: '',
        apiKey: '',
      },
    ])
  }

  const removeProviderPreset = (providerId: string) => {
    setProviderPresets((prev) => prev.filter((item) => item.id !== providerId))
    setModelPresets((prev) => prev.filter((item) => item.providerId !== providerId))
  }

  const addModelPreset = () => {
    const providerId = providerPresets[0]?.id ?? ''
    if (!providerId) {
      setStatusMessage('Add a provider first.')
      return
    }
    setModelPresets((prev) => [
      ...prev,
      {
        id: createLocalId('model'),
        name: 'New Model',
        modelId: '',
        providerId,
      },
    ])
  }

  const saveAIConfiguration = async () => {
    const target = buildSelectedAISettings()
    if (!target) {
      setStatusMessage('Select a valid model/provider pair.')
      return
    }
    if (!target.modelId.trim()) {
      setStatusMessage('Model ID is required.')
      return
    }
    if (!target.apiKey.trim()) {
      setStatusMessage('API key is required for the selected provider.')
      return
    }
    await saveAISettingsAction(target)
    setSettingsOpen(false)
  }

  const runAgent = async () => {
    if (!activeBoardId || !agentPrompt.trim()) return
    const prompt = agentPrompt.trim()
    const targetSettings = buildSelectedAISettings()
    if (!targetSettings) {
      setStatusMessage('Select a valid model/provider pair in settings.')
      return
    }
    if (!targetSettings.apiKey.trim()) {
      setStatusMessage('API key is required for the selected provider.')
      return
    }
    const shouldSaveSettings =
      aiSettings.providerType !== targetSettings.providerType ||
      aiSettings.providerName !== targetSettings.providerName ||
      aiSettings.baseUrl !== targetSettings.baseUrl ||
      aiSettings.modelName !== targetSettings.modelName ||
      aiSettings.modelId !== targetSettings.modelId ||
      aiSettings.apiKey !== targetSettings.apiKey

    setAgentLoading(true)
    setChatMessages((prev) => [
      ...prev,
      {
        id: createLocalId('msg'),
        role: 'user',
        content: prompt,
        createdAt: new Date().toISOString(),
      },
    ])
    setAgentPrompt('')
    try {
      if (shouldSaveSettings) {
        await saveAISettingsAction(targetSettings)
      }
      if (agentMode === 'chat') {
        const result = await api.askAgent({
          boardId: activeBoardId,
          question: prompt,
          selectedElementId: selectedElementId ?? undefined,
          viewOrigin: { x: viewport.x, y: viewport.y },
        })
        setChatMessages((prev) => [
          ...prev,
          {
            id: createLocalId('msg'),
            role: 'assistant',
            content: result.answer,
            createdAt: new Date().toISOString(),
          },
        ])
      } else {
        const result: AgentBuildResponse = await api.buildWithAgent({
          boardId: activeBoardId,
          prompt,
          selectedElementId: selectedElementId ?? undefined,
          viewOrigin: { x: viewport.x, y: viewport.y },
        })
        commitElements(result.elements)
        setChatMessages((prev) => [
          ...prev,
          {
            id: createLocalId('msg'),
            role: 'assistant',
            content: `${result.message}\n\nApplied ${result.operations.length} operations.`,
            createdAt: new Date().toISOString(),
          },
        ])
      }
    } catch (error) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: createLocalId('msg'),
          role: 'assistant',
          content: error instanceof Error ? error.message : 'Agent request failed.',
          createdAt: new Date().toISOString(),
        },
      ])
    } finally {
      setAgentLoading(false)
    }
  }

  const orderedElements = useMemo(() => [...elements].sort(compareElementStack), [elements])
  const maxElementZIndex = useMemo(
    () => elements.reduce((max, element) => Math.max(max, element.zIndex), 0),
    [elements],
  )

  const draftPenPreview = useMemo(() => {
    if (draft?.type !== 'pen' || draft.points.length < 2) return null
    return createPenElement(draft.points, getNextZIndex(elements), {
      stroke: penColor,
      strokeWidth: penStrokeWidth,
    })
  }, [draft, elements, penColor, penStrokeWidth])
  const compassDrawPreview = useMemo(() => {
    if (drag?.kind !== 'compass-draw' || drag.points.length < 2) return null
    return createPenElement(drag.points, getNextZIndex(elements), {
      stroke: drag.stroke,
      strokeWidth: drag.strokeWidth,
    })
  }, [drag, elements])
  const domElements = orderedElements
  const editingTextElement = useMemo(
    () => domElements.find((element) => element.id === editingTextId && isEditableTextElement(element)) ?? null,
    [domElements, editingTextId],
  )
  const selectedMonacoElement = useMemo(
    () => elements.find((element): element is MonacoElement => element.id === selectedElementId && isMonacoElement(element)) ?? null,
    [elements, selectedElementId],
  )
  const selectedCodeElement = useMemo(
    () => elements.find((element): element is CodeElement => element.id === selectedElementId && isCodeElement(element)) ?? null,
    [elements, selectedElementId],
  )
  const selectedCompassElement = useMemo(
    () =>
      elements.find(
        (element): element is Extract<BoardElement, { type: 'compass' }> =>
          element.id === selectedElementId && element.type === 'compass',
      ) ?? null,
    [elements, selectedElementId],
  )
  const visibleWorldRect = useMemo(() => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const width = rect?.width ?? 0
    const height = rect?.height ?? 0
    return {
      x: viewport.x,
      y: viewport.y,
      width: width / viewport.zoom,
      height: height / viewport.zoom,
    }
  }, [viewport])

  const gridStyle = useMemo(() => {
    const step = GRID_STEP * viewport.zoom
    const offsetX = (-viewport.x * viewport.zoom) % step
    const offsetY = (-viewport.y * viewport.zoom) % step
    return {
      backgroundPosition: `${offsetX}px ${offsetY}px, ${offsetX}px ${offsetY}px`,
      backgroundSize: `${step}px ${step}px, ${step}px ${step}px`,
    }
  }, [viewport.x, viewport.y, viewport.zoom])

  const canvasCursor = useMemo(() => {
    if (drag?.kind === 'move' || drag?.kind === 'canvas') {
      return 'grabbing'
    }
    if (tool === 'select') {
      return 'grab'
    }
    return 'default'
  }, [drag, tool])

  useEffect(() => {
    const canvas = penCanvasRef.current
    const root = canvasRef.current
    if (!canvas || !root) return
    const rect = root.getBoundingClientRect()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.floor(rect.width * dpr))
    canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.save()
    ctx.translate(-viewport.x * viewport.zoom, -viewport.y * viewport.zoom)
    ctx.scale(viewport.zoom, viewport.zoom)
    if (draftPenPreview) {
      const absolutePoints = draftPenPreview.points.map((point) => ({
        x: draftPenPreview.x + point.x,
        y: draftPenPreview.y + point.y,
      }))
      const polygon = getStrokePolygon(absolutePoints, draftPenPreview.strokeWidth)
      drawStrokePolygon(ctx, polygon, draftPenPreview.stroke)
    }
    if (compassDrawPreview) {
      const absolutePoints = compassDrawPreview.points.map((point) => ({
        x: compassDrawPreview.x + point.x,
        y: compassDrawPreview.y + point.y,
      }))
      const polygon = getStrokePolygon(absolutePoints, compassDrawPreview.strokeWidth)
      drawStrokePolygon(ctx, polygon, compassDrawPreview.stroke)
    }
    if (draft?.type === 'shape') {
      ctx.strokeStyle = shapeColor
      ctx.fillStyle =
        draft.tool === 'rectangle' || draft.tool === 'ellipse'
          ? shapeFilled
            ? getShapeFillColor(shapeColor)
            : 'transparent'
          : 'transparent'
      ctx.lineWidth = shapeStrokeWidth
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (draft.tool === 'line') {
        ctx.beginPath()
        ctx.moveTo(draft.start.x, draft.start.y)
        ctx.lineTo(draft.end.x, draft.end.y)
        ctx.stroke()
      } else if (draft.tool === 'arrow') {
        const dx = draft.end.x - draft.start.x
        const dy = draft.end.y - draft.start.y
        const len = Math.max(1, Math.hypot(dx, dy))
        const ux = dx / len
        const uy = dy / len
        const headLength = Math.max(11, shapeStrokeWidth * 4.2)
        const wing = Math.max(6, shapeStrokeWidth * 2.1)
        const shaftEnd = {
          x: draft.end.x - ux * headLength * 0.72,
          y: draft.end.y - uy * headLength * 0.72,
        }
        const bx = draft.end.x - ux * headLength
        const by = draft.end.y - uy * headLength
        const lx = bx + -uy * wing
        const ly = by + ux * wing
        const rx = bx - -uy * wing
        const ry = by - ux * wing
        ctx.beginPath()
        ctx.moveTo(draft.start.x, draft.start.y)
        ctx.lineTo(shaftEnd.x, shaftEnd.y)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(draft.end.x, draft.end.y)
        ctx.lineTo(lx, ly)
        ctx.lineTo(rx, ry)
        ctx.closePath()
        ctx.fill()
      } else if (draft.tool === 'rectangle') {
        const { x, y, width, height } = normalizeRect(draft.start, draft.end, SHAPE_MIN_SIZE, SHAPE_MIN_SIZE)
        drawRectanglePreview(ctx, x, y, width, height, shapeFilled)
      } else if (draft.tool === 'ellipse') {
        const { x, y, width, height } = normalizeRect(draft.start, draft.end, SHAPE_MIN_SIZE, SHAPE_MIN_SIZE)
        drawEllipsePreview(ctx, x, y, width, height, shapeFilled)
      }
    }
    ctx.restore()
  }, [compassDrawPreview, draft, draftPenPreview, shapeColor, shapeFilled, shapeStrokeWidth, viewport, visibleWorldRect])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Sparkles size={18} />
          <div>
            <strong>Whiteboard Pro</strong>
            <span>{statusMessage} · Assets {assets.length}</span>
          </div>
        </div>
        <div className="board-controls">
          <select
            value={activeBoardId}
            onChange={(event) => {
              void switchBoard(event.target.value)
            }}
            title="Boards"
          >
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </select>
          <button onClick={() => void createBoardAction()} title="Create board">
            <Plus size={16} /> New
          </button>
          <button onClick={() => void renameBoardAction()} disabled={!activeBoard}>
            <FolderOpen size={16} /> Rename
          </button>
          <button onClick={() => void deleteBoardAction()} disabled={!activeBoard}>
            <Trash2 size={16} /> Delete
          </button>
          <button onClick={() => void saveNow()}>
            <Save size={16} /> Save
          </button>
          <button
            onClick={() => {
              setSettingsSection('ai')
              setSettingsOpen(true)
            }}
          >
            <Settings2 size={16} /> Settings
          </button>
          <button onClick={() => setAiOpen((value) => !value)}>
            {aiOpen ? <SidebarClose size={16} /> : <SidebarOpen size={16} />} AI
          </button>
        </div>
      </header>

      <div className={`workspace ${aiOpen ? 'ai-open' : 'ai-closed'}`}>
        <main className="canvas-wrap">
          <div className="canvas-toolbar">
            <div className="toolbar-tooltip" data-tooltip="Undo">
              <button onClick={undo} disabled={history.length === 0}>
                <Undo size={14} />
              </button>
            </div>
            <div className="toolbar-tooltip" data-tooltip="Redo">
              <button onClick={redo} disabled={future.length === 0}>
                <Redo size={14} />
              </button>
            </div>
            <div className="toolbar-tooltip" data-tooltip="Clear All">
              <button onClick={() => void clearAllElements()} disabled={elements.length === 0}>
                <CircleX size={14} /> 
              </button>
            </div>
            <div className="toolbar-tooltip" data-tooltip="Zoom In">
              <button onClick={() => zoomBy(1.1)}>
                <ZoomIn size={14} />
              </button>
            </div>
            <div className="toolbar-tooltip" data-tooltip="Zoom Out">
              <button onClick={() => zoomBy(0.9)}>
                <ZoomOut size={14} />
              </button>
            </div>
            <div className="toolbar-tooltip" data-tooltip="Center View">
              <button onClick={resetView}>Center</button>
            </div>
            {tool === 'code' || tool === 'monaco' || selectedCodeElement || selectedMonacoElement ? (
              <label className="toolbar-select" title="Editor language">
                <SquareCode size={13} />
                <select
                  value={selectedMonacoElement?.language ?? selectedCodeElement?.language ?? codeLanguage}
                  onChange={(event) => {
                    const value = event.target.value
                    setCodeLanguage(value)
                    setElements((prev) =>
                      prev.map((item) => {
                        if (selectedMonacoElement && item.id === selectedMonacoElement.id && item.type === 'monaco') {
                          return {
                            ...item,
                            language: value,
                            updatedAt: new Date().toISOString(),
                          }
                        }
                        if (selectedCodeElement && item.id === selectedCodeElement.id && item.type === 'code') {
                          return {
                            ...item,
                            language: value,
                            updatedAt: new Date().toISOString(),
                          }
                        }
                        return item
                      }),
                    )
                  }}
                >
                  {MONACO_LANGUAGES.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {tool === 'eraser-stroke' ? (
              <>
                <label className="eraser-size" title="Eraser size">
                  <Eraser size={13} />
                  <input
                    type="range"
                    min={4}
                    max={64}
                    step={1}
                    value={eraserRadius}
                    onChange={(event) => setEraserRadius(Number(event.target.value))}
                  />
                  <span>{eraserRadius}px</span>
                </label>
                <button
                  className={eraserPenOnly ? 'tool-button active' : 'tool-button'}
                  onClick={() => setEraserPenOnly((value) => !value)}
                  title="Erase pen strokes only"
                  data-tooltip="Pen Only"
                >
                  Pen Only
                </button>
              </>
            ) : null}
            {tool === 'pen' ? (
              <>
                <label className="eraser-size" title="Pen thickness">
                  <PenTool size={13} />
                  <input
                    type="range"
                    min={1}
                    max={24}
                    step={1}
                    value={penStrokeWidth}
                    onChange={(event) => setPenStrokeWidth(Number(event.target.value))}
                  />
                  <span>{penStrokeWidth}px</span>
                </label>
                <label className="pen-color-control" title="Pen color">
                  <input
                    type="color"
                    value={penColor}
                    onChange={(event) => setPenColor(event.target.value)}
                    aria-label="Pen color"
                  />
                </label>
              </>
            ) : null}
            {tool === 'select' && selectedCompassElement ? (
              <>
                <label className="eraser-size" title="Compass stroke thickness">
                  <Compass size={13} />
                  <input
                    type="range"
                    min={1}
                    max={8}
                    step={1}
                    value={clamp(selectedCompassElement.strokeWidth, 1, 8)}
                    onChange={(event) => {
                      const nextStrokeWidth = Number(event.target.value)
                      setElements((prev) => {
                        const next = prev.map((element) =>
                          element.id === selectedCompassElement.id && element.type === 'compass'
                            ? { ...element, strokeWidth: nextStrokeWidth, updatedAt: new Date().toISOString() }
                            : element,
                        )
                        elementsRef.current = next
                        return next
                      })
                    }}
                  />
                  <span>{clamp(selectedCompassElement.strokeWidth, 1, 8)}px</span>
                </label>
                <label className="pen-color-control" title="Compass stroke color">
                  <input
                    type="color"
                    value={selectedCompassElement.stroke}
                    onChange={(event) => {
                      const nextStroke = event.target.value
                      setElements((prev) => {
                        const next = prev.map((element) =>
                          element.id === selectedCompassElement.id && element.type === 'compass'
                            ? { ...element, stroke: nextStroke, updatedAt: new Date().toISOString() }
                            : element,
                        )
                        elementsRef.current = next
                        return next
                      })
                    }}
                    aria-label="Compass stroke color"
                  />
                </label>
              </>
            ) : null}
            {(tool === 'line' || tool === 'arrow' || tool === 'rectangle' || tool === 'ellipse') ? (
              <>
                <label className="eraser-size" title="Shape thickness">
                  <Minus size={13} />
                  <input
                    type="range"
                    min={1}
                    max={8}
                    step={1}
                    value={shapeStrokeWidth}
                    onChange={(event) => setShapeStrokeWidth(Number(event.target.value))}
                  />
                  <span>{shapeStrokeWidth}px</span>
                </label>
                {(tool === 'rectangle' || tool === 'ellipse') ? (
                  <button
                    className={shapeFilled ? 'tool-button active' : 'tool-button'}
                    onClick={() => setShapeFilled((value) => !value)}
                    title="Toggle shape fill"
                  >
                    Fill
                  </button>
                ) : null}
                <label className="pen-color-control" title="Shape color">
                  <input
                    type="color"
                    value={shapeColor}
                    onChange={(event) => setShapeColor(event.target.value)}
                    aria-label="Shape color"
                  />
                </label>
              </>
            ) : null}
            <span className="canvas-toolbar-meta">
              Canvas {sizeFormatter.format(CANVAS_WIDTH)} x {sizeFormatter.format(CANVAS_HEIGHT)}
            </span>
          </div>
          <input ref={assetInputRef} type="file" hidden onChange={onAssetFileChange} />

          <div
            className="canvas-root"
            style={{ ...gridStyle, cursor: canvasCursor }}
            ref={canvasRef}
            onDragStart={(event) => event.preventDefault()}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerLeave}
            onWheel={onWheel}
          >
            <div
              className="tool-popup"
              role="toolbar"
              aria-label="Whiteboard tools"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                className={tool === 'select' ? 'active tool-button tool-select-fixed' : 'tool-button tool-select-fixed'}
                title="Select"
                aria-label="Select"
                data-tooltip="Select"
                onClick={() => handleToolSelect('select')}
              >
                <MousePointer2 size={16} />
              </button>
              {(openToolCategory
                ? CATEGORY_DEFS.filter((category) => category.id === openToolCategory)
                : CATEGORY_DEFS
              ).map((category) => {
                const CategoryIcon = category.icon
                const isOpen = openToolCategory === category.id
                const ToggleIcon = isOpen ? ChevronLeft : CategoryIcon
                return (
                  <div
                    key={category.id}
                    className={`tool-category ${isOpen ? 'open' : 'closed'}`}
                  >
                    <button
                      className={`tool-category-toggle ${isOpen ? 'active' : ''}`}
                      title={category.label}
                      aria-label={isOpen ? 'Go Back' : category.label}
                      data-tooltip={isOpen ? 'Go Back' : category.label}
                      onClick={() => toggleToolCategory(category.id)}
                    >
                      <ToggleIcon size={16} />
                    </button>
                    {isOpen ? (
                      <div className="tool-popup-group">
                        {CATEGORY_TOOL_DEFS.filter((item) => item.category === category.id).map((item) => {
                          const Icon = item.icon
                          return (
                            <button
                              key={item.id}
                              className={tool === item.id ? 'active tool-button' : 'tool-button'}
                              title={item.label}
                              aria-label={item.label}
                              data-tooltip={item.label}
                              onClick={() => handleToolSelect(item.id)}
                            >
                              <Icon size={16} />
                            </button>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
            {tool === 'eraser-stroke' && eraserPointer ? (
              <div
                className="eraser-preview"
                style={{
                  width: eraserRadius * 2 * viewport.zoom,
                  height: eraserRadius * 2 * viewport.zoom,
                  left: (eraserPointer.x - viewport.x) * viewport.zoom,
                  top: (eraserPointer.y - viewport.y) * viewport.zoom,
                }}
              />
            ) : null}
            <canvas className="pen-layer" ref={penCanvasRef} />
            <div
              className="canvas-surface"
              style={{
                width: CANVAS_WIDTH,
                height: CANVAS_HEIGHT,
                transform: `translate(${-viewport.x * viewport.zoom}px, ${-viewport.y * viewport.zoom}px) scale(${viewport.zoom})`,
                transformOrigin: 'top left',
              }}
            >
              {domElements.map((element) => {
                const selected = element.id === selectedElementId
                const visuallySelected = selected && element.type !== 'compass'
                const interactiveInSelectMode =
                  tool === 'select' &&
                  !drag &&
                  ((selected &&
                    (element.type === 'iframe' ||
                      element.type === 'video' ||
                      element.type === 'file' ||
                      element.type === 'code' ||
                      element.type === 'monaco')) ||
                    element.type === 'text' ||
                    element.type === 'markdown' ||
                    editingTextId === element.id)
                return (
                  <div
                    key={element.id}
                    className={`element element-${element.type} ${visuallySelected ? 'selected' : ''} ${interactiveInSelectMode ? 'interactive' : ''}`}
                    onDragStart={(event) => event.preventDefault()}
                    style={{
                      left:
                        element.type === 'pen'
                          ? 0
                          : element.x,
                      top:
                        element.type === 'pen'
                          ? 0
                          : element.y,
                      width:
                        element.type === 'pen'
                          ? CANVAS_WIDTH
                          : element.width,
                      height:
                        element.type === 'pen'
                          ? CANVAS_HEIGHT
                          : element.height,
                      zIndex: getRenderZIndex(element, maxElementZIndex),
                      overflow:
                        element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'compass'
                          ? 'visible'
                          : undefined,
                      background:
                        element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'latex' || element.type === 'pen'
                          ? 'transparent'
                          : element.fill,
                      transform: element.type === 'pen' ? undefined : `rotate(${element.rotation}deg)`,
                    }}
                  >
                    {element.type === 'pen' ? (
                      <svg width={CANVAS_WIDTH} height={CANVAS_HEIGHT} style={{ overflow: 'visible' }}>
                        <path
                          d={strokePolygonToPath(
                            getStrokePolygon(
                              element.points.map((point) => ({
                                x: element.x + point.x,
                                y: element.y + point.y,
                              })),
                              element.strokeWidth,
                            ),
                          )}
                          fill={element.stroke}
                        />
                      </svg>
                    ) : null}
                    {element.type === 'line' ? (
                      <svg width={element.width} height={element.height} style={{ overflow: 'visible' }}>
                        {(() => {
                          const start = element.linePoints?.[0] ?? { x: 0, y: element.height }
                          const end = element.linePoints?.[1] ?? { x: element.width, y: 0 }
                          return (
                            <line
                              x1={start.x}
                              y1={start.y}
                              x2={end.x}
                              y2={end.y}
                              stroke={element.stroke}
                              strokeWidth={element.strokeWidth}
                              strokeLinecap="round"
                            />
                          )
                        })()}
                      </svg>
                    ) : null}
                    {element.type === 'arrow' ? (
                      <svg width={element.width} height={element.height} style={{ overflow: 'visible' }}>
                        {(() => {
                          const start = element.linePoints?.[0] ?? { x: 0, y: element.height }
                          const end = element.linePoints?.[1] ?? { x: element.width, y: 0 }
                          const dx = end.x - start.x
                          const dy = end.y - start.y
                          const len = Math.max(1, Math.hypot(dx, dy))
                          const ux = dx / len
                          const uy = dy / len
                          const headLength = Math.max(11, element.strokeWidth * 4.2)
                          const wing = Math.max(6, element.strokeWidth * 2.1)
                          const shaftEnd = {
                            x: end.x - ux * headLength * 0.72,
                            y: end.y - uy * headLength * 0.72,
                          }
                          const bx = end.x - ux * headLength
                          const by = end.y - uy * headLength
                          const lx = bx + -uy * wing
                          const ly = by + ux * wing
                          const rx = bx - -uy * wing
                          const ry = by - ux * wing
                          return (
                            <>
                              <line
                                x1={start.x}
                                y1={start.y}
                                x2={shaftEnd.x}
                                y2={shaftEnd.y}
                                stroke={element.stroke}
                                strokeWidth={element.strokeWidth}
                                strokeLinecap="round"
                              />
                              <polygon points={`${end.x},${end.y} ${lx},${ly} ${rx},${ry}`} fill={element.stroke} />
                            </>
                          )
                        })()}
                      </svg>
                    ) : null}
                    {element.type === 'rectangle' ? renderRectangleSvg(element) : null}
                    {element.type === 'ellipse' ? renderEllipseSvg(element) : null}
                    {element.type === 'iframe' ? <iframe src={element.src} title={element.title} loading="lazy" /> : null}
                    {(element.type === 'image' || element.type === 'video') && element.src ? (
                      element.type === 'image' ? <img src={element.src} alt={element.name} /> : <video src={element.src} controls />
                    ) : null}
                    {element.type === 'code' ? (
                      <div className="code-block" onPointerDown={(event) => selected && event.stopPropagation()}>
                        <div className="code-block-head">{element.language}</div>
                        {selected && tool === 'select' ? (
                          <textarea
                            className="code-block-input"
                            value={element.code}
                            onChange={(event) => {
                              const value = event.target.value
                              setElements((prev) =>
                                prev.map((item) =>
                                  item.id === element.id && item.type === 'code'
                                    ? {
                                        ...item,
                                        code: value,
                                        updatedAt: new Date().toISOString(),
                                      }
                                    : item,
                                ),
                              )
                            }}
                          />
                        ) : (
                          <pre className="code-block-pre">
                            <code>{element.code}</code>
                          </pre>
                        )}
                      </div>
                    ) : null}
                    {element.type === 'monaco' ? (
                      <div className="monaco-box" onPointerDown={(event) => selected && event.stopPropagation()}>
                        <Editor
                          height="100%"
                          defaultLanguage="javascript"
                          language={element.language}
                          value={element.code}
                          beforeMount={(monaco) => {
                            monaco.editor.defineTheme('whiteboard-gray', {
                              base: 'vs',
                              inherit: true,
                              rules: [],
                              colors: {
                                'editor.background': '#EEF1F4',
                                'editorGutter.background': '#EEF1F4',
                                'minimap.background': '#EEF1F4',
                              },
                            })
                          }}
                          theme="whiteboard-gray"
                          options={{
                            minimap: { enabled: false },
                            fontSize: 15,
                            wordWrap: 'on',
                            lineNumbers: 'on',
                            readOnly: !(tool === 'select' && selected),
                            scrollBeyondLastLine: false,
                            overviewRulerLanes: 0,
                            padding: { top: 12, bottom: 12 },
                          }}
                          onChange={(value: string | undefined) => {
                            if (!(tool === 'select' && selected)) return
                            setElements((prev) =>
                              prev.map((item) =>
                                item.id === element.id && item.type === 'monaco'
                                  ? {
                                      ...item,
                                      code: value ?? '',
                                      updatedAt: new Date().toISOString(),
                                    }
                                  : item,
                              ),
                            )
                          }}
                        />
                      </div>
                    ) : null}
                    {element.type === 'file' ? (
                      <div className="file-card">
                        <File size={18} />
                        <div>
                          <strong>{element.name}</strong>
                          <a href={element.src} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        </div>
                      </div>
                    ) : null}
                    {element.type === 'compass' ? (
                      <svg
                        width={element.width}
                        height={element.height}
                        viewBox={`0 0 ${COMPASS_SOURCE_WIDTH} ${COMPASS_SOURCE_HEIGHT}`}
                        style={{ overflow: 'visible' }}
                      >
                        {(() => {
                          const geometry = getCompassLocalGeometry(element.radius)
                          const openRotateDegrees =
                            ((geometry.rightAbsoluteAngle - COMPASS_RIGHT_BASE_ABSOLUTE_ANGLE) * 180) / Math.PI
                          const drawRotateDegrees = signedAngleDelta(element.endAngle, geometry.baseDrawAngle)
                          return (
                            <>
                              <defs>
                                <filter id={`compass-shadow-${element.id}`}>
                                  <feDropShadow dx="1" dy="3" stdDeviation="4" floodColor="#00000022" />
                                </filter>
                              </defs>
                              <g transform={`rotate(${drawRotateDegrees} ${COMPASS_LEFT_TIP_SOURCE.x} ${COMPASS_LEFT_TIP_SOURCE.y})`}>
                                <line
                                  x1="138"
                                  y1="96"
                                  x2="75"
                                  y2="310"
                                  stroke="#E0607A"
                                  strokeWidth="9"
                                  strokeLinecap="butt"
                                  filter={`url(#compass-shadow-${element.id})`}
                                />
                                <g
                                  transform="matrix(0.949972, 0.312335, -0.312335, 0.949972, 75, 310)"
                                  filter={`url(#compass-shadow-${element.id})`}
                                >
                                  <polygon points="-4.482 0.135 4.504 -0.176 0.018 24.135" fill="#bbb" />
                                  <polygon points="-2.258 11.974 2.258 12.012 0.014 24.167" fill="#444" />
                                </g>
                                <g transform={`rotate(${openRotateDegrees} ${COMPASS_HINGE_SOURCE.x} ${COMPASS_HINGE_SOURCE.y})`}>
                                  <line
                                    x1="162"
                                    y1="96"
                                    x2="225"
                                    y2="310"
                                    stroke="#222"
                                    strokeWidth="9"
                                    strokeLinecap="butt"
                                    filter={`url(#compass-shadow-${element.id})`}
                                  />
                                  <polygon
                                    points="220.624 311.375 229.323 308.588 232.566 332.488"
                                    fill="#F0D9A0"
                                    filter={`url(#compass-shadow-${element.id})`}
                                  />
                                  <polygon
                                    points="227.191 322.929 231.106 321.658 232.565 332.552"
                                    fill="#111111"
                                    filter={`url(#compass-shadow-${element.id})`}
                                  />
                                </g>
                                <g transform="matrix(1, 0, 0, 1, 0.514076, 3.084455)">
                                  <g>
                                    <circle cx="150" cy="80" r="22" fill="#F5A623" filter={`url(#compass-shadow-${element.id})`} />
                                  </g>
                                  <circle cx="150" cy="80" r="10" fill="#C47800" filter={`url(#compass-shadow-${element.id})`} />
                                </g>
                              </g>
                            </>
                          )
                        })()}
                      </svg>
                    ) : null}
                    {element.type === 'graph' ? (
                      <div className="graph">
                        <svg width={element.width} height={element.height}>
                          <line x1="0" y1={element.height / 2} x2={element.width} y2={element.height / 2} stroke="#122028" />
                          <line x1={element.width / 2} y1="0" x2={element.width / 2} y2={element.height} stroke="#122028" />
                        </svg>
                      </div>
                    ) : null}
                    {element.type === 'latex' ? (
                      <div
                        className="latex"
                        style={{ fontSize: element.fontSize }}
                        dangerouslySetInnerHTML={{ __html: renderLatexToHtml(element.latex) }}
                      />
                    ) : null}
                    {element.type === 'text' ? (
                      editingTextId === element.id ? null : (
                        <div
                          className="text-box-content"
                          style={{ fontSize: element.fontSize }}
                          onPointerDown={(event) => {
                            event.stopPropagation()
                          }}
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedElementId(element.id)
                          }}
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                            setSelectedElementId(element.id)
                            setEditingTextId(element.id)
                          }}
                        >
                          {element.text || 'Text'}
                        </div>
                      )
                    ) : null}
                    {element.type === 'markdown' ? (
                      editingTextId === element.id ? null : (
                        <div
                          className="text-box-content markdown-box-content"
                          style={{ fontSize: element.fontSize }}
                          onPointerDown={(event) => {
                            event.stopPropagation()
                          }}
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedElementId(element.id)
                          }}
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                            setSelectedElementId(element.id)
                            setEditingTextId(element.id)
                          }}
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdownToHtml(element.text || '# Markdown'),
                          }}
                        />
                      )
                    ) : null}
                    {element.type === 'ruler' ? (
                      <div className="ruler">
                        <svg width={element.width} height={element.height}>
                          {(() => {
                            const totalTicks = element.units * 10
                            const leftPad = 12
                            const rightPad = 12
                            const usableWidth = Math.max(20, element.width - leftPad - rightPad)
                            const baseY = 0.5
                            const labelY = element.height - 2
                            return (
                              <>
                                <line
                                  x1={leftPad}
                                  y1={baseY}
                                  x2={element.width - rightPad}
                                  y2={baseY}
                                  stroke="#1c2f38"
                                  strokeWidth={1.2}
                                />
                                {Array.from({ length: totalTicks + 1 }).map((_, index) => {
                                  const x = leftPad + (index / totalTicks) * usableWidth
                                  const tickHeight =
                                    index % 10 === 0
                                      ? 36
                                      : index % 5 === 0
                                        ? 26
                                        : index % 2 === 0
                                          ? 18
                                          : 12
                                  return (
                                    <line
                                      key={`tick-${index}`}
                                      x1={x}
                                      y1={baseY}
                                      x2={x}
                                      y2={Math.min(element.height - 20, baseY + tickHeight)}
                                      stroke="#1c2f38"
                                      strokeWidth={index % 10 === 0 ? 1.4 : 1}
                                    />
                                  )
                                })}
                                {Array.from({ length: element.units + 1 }).map((_, index) => {
                                  const textX = leftPad + (index / element.units) * usableWidth
                                  return (
                                    <text
                                      key={`label-${index}`}
                                      x={textX}
                                      y={labelY}
                                      textAnchor="middle"
                                      dominantBaseline="text-after-edge"
                                      fontSize="11"
                                      fontWeight="700"
                                      fill="#13252e"
                                    >
                                      {index}
                                    </text>
                                  )
                                })}
                              </>
                            )
                          })()}
                        </svg>
                      </div>
                    ) : null}
                    {element.type === 'protractor' ? (
                      <div className="protractor">
                        <svg width={element.width} height={element.height}>
                          {(() => {
                            const cx = element.width / 2
                            const cy = element.height - 2
                            const outerRadius = Math.max(40, Math.min(element.width / 2 - 2, element.height - 2))
                            const labelRadius = Math.max(20, outerRadius - 36)
                            return (
                              <>
                                <circle cx={cx} cy={cy} r={4} fill="#1f5f84" />
                                <circle cx={cx} cy={cy} r={1.8} fill="#ffffff" />
                                {Array.from({ length: 181 }).map((_, index) => {
                                  const angle = (index * Math.PI) / 180
                                  const r1 = outerRadius
                                  const r2 =
                                    index % 10 === 0
                                      ? outerRadius - 22
                                      : index % 5 === 0
                                        ? outerRadius - 15
                                        : outerRadius - 9
                                  const x1 = cx + Math.cos(Math.PI - angle) * r1
                                  const y1 = cy - Math.sin(Math.PI - angle) * r1
                                  const x2 = cx + Math.cos(Math.PI - angle) * r2
                                  const y2 = cy - Math.sin(Math.PI - angle) * r2
                                  return (
                                    <line
                                      key={index}
                                      x1={x1}
                                      y1={y1}
                                      x2={x2}
                                      y2={y2}
                                      stroke="#1f5f84"
                                      strokeWidth={index % 10 === 0 ? 1.2 : 1}
                                    />
                                  )
                                })}
                                {Array.from({ length: 19 }).map((_, index) => {
                                  const degree = index * 10
                                  const angle = (degree * Math.PI) / 180
                                  const x = cx + Math.cos(Math.PI - angle) * labelRadius
                                  const y = cy - Math.sin(Math.PI - angle) * labelRadius
                                  return (
                                    <text key={degree} x={x} y={y} fontSize="9.5" textAnchor="middle" fill="#1f5f84">
                                      {degree}
                                    </text>
                                  )
                                })}
                              </>
                            )
                          })()}
                        </svg>
                      </div>
                    ) : null}
                    {visuallySelected && element.type !== 'ruler' ? <span className="resize-handle" /> : null}
                    {visuallySelected ? <span className="rotate-handle" /> : null}
                  </div>
                )
              })}
              {editingTextElement && isEditableTextElement(editingTextElement) ? (
                <div
                  className="text-edit-overlay"
                  style={{
                    left: editingTextElement.x,
                    top: editingTextElement.y,
                    width: editingTextElement.width,
                    height: editingTextElement.height,
                    zIndex: editingTextElement.zIndex + 1000,
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <textarea
                    className="text-box-input"
                    ref={editingTextRef}
                    value={editingTextElement.text}
                    autoFocus
                    placeholder={editingTextElement.type === 'markdown' ? 'Write Markdown here' : 'Type here'}
                    onChange={(event) => {
                      const value = event.target.value
                      setElements((prev) =>
                        prev.map((item) =>
                          item.id === editingTextElement.id && isEditableTextElement(item)
                            ? {
                                ...item,
                                text: value,
                                updatedAt: new Date().toISOString(),
                              }
                            : item,
                        ),
                      )
                    }}
                    onBlur={() => setEditingTextId(null)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setEditingTextId(null)
                      }
                    }}
                    style={{ fontSize: editingTextElement.fontSize }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </main>

        {aiOpen ? (
          <aside className="ai-panel open">
          <div className="ai-head">
            <h2>AI Chat</h2>
            <div className="mode-toggle">
              <button className={agentMode === 'chat' ? 'active' : ''} onClick={() => setAgentMode('chat')}>
                <MessageSquare size={14} />
                Ask
              </button>
              <button className={agentMode === 'build' ? 'active' : ''} onClick={() => setAgentMode('build')}>
                <Sparkles size={14} />
                Build
              </button>
            </div>
          </div>

          <div className="chat-window" ref={chatWindowRef}>
            {chatMessages.length === 0 ? <div className="chat-empty">Start a conversation by sending your first message.</div> : null}
            {chatMessages.map((message) => (
              <div key={message.id} className={`chat-message ${message.role}`}>
                <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
                <p>{message.content}</p>
              </div>
            ))}
          </div>

          <div className="chat-compose">
            <textarea
              value={agentPrompt}
              onChange={(event) => setAgentPrompt(event.target.value)}
              placeholder={agentMode === 'chat' ? 'Describe what you want to ask...' : 'Describe what to add, update, or delete...'}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void runAgent()
                }
              }}
            />

            <div className="chat-compose-toolbar">
              <div className="chat-compose-left">
                <button className="compose-tool-btn" type="button" aria-label="Add">
                  <Plus size={14} />
                </button>
                <CustomDropdown
                  className="compose-mode-dropdown"
                  value={agentMode}
                  onChange={(value) => setAgentMode(value as AgentMode)}
                  options={[
                    { value: 'chat', label: 'Ask' },
                    { value: 'build', label: 'Build' },
                  ]}
                />
                <CustomDropdown
                  className="compose-model-dropdown"
                  value={selectedChatModelId}
                  onChange={setSelectedChatModelId}
                  options={modelPresets.map((model) => ({
                    value: model.id,
                    label: model.name,
                  }))}
                  placeholder="Model"
                />
                <button
                  className="compose-tool-btn"
                  type="button"
                  onClick={() => {
                    setSettingsSection('ai')
                    setSettingsOpen(true)
                  }}
                  aria-label="Model settings"
                >
                  <SlidersHorizontal size={14} />
                </button>
              </div>
              <button className="compose-send-btn" onClick={() => void runAgent()} disabled={agentLoading}>
                <Send size={14} />
              </button>
            </div>
          </div>
          </aside>
        ) : null}
      </div>

      {settingsOpen ? (
        <div className="settings-page">
          <div className="settings-shell">
            <aside className="settings-nav">
              <div className="settings-nav-head">
                <h2>Settings</h2>
                <p>Global workspace preferences</p>
              </div>
              <button
                className={settingsSection === 'workspace' ? 'settings-nav-item active' : 'settings-nav-item'}
                onClick={() => setSettingsSection('workspace')}
              >
                Workspace
              </button>
              <button
                className={settingsSection === 'ai' ? 'settings-nav-item active' : 'settings-nav-item'}
                onClick={() => setSettingsSection('ai')}
              >
                AI
              </button>
            </aside>
            <section className="settings-content">
              <div className="settings-content-head">
                <h3>{settingsSection === 'ai' ? 'AI Settings' : 'Workspace Settings'}</h3>
                <button className="settings-close-btn" onClick={() => setSettingsOpen(false)}>
                  <ChevronLeft size={14} /> Back to board
                </button>
              </div>

              {settingsSection === 'workspace' ? (
                <div className="settings-placeholder">
                  <p>Workspace settings can be added here later.</p>
                </div>
              ) : (
                <div className="settings-section-stack">
                  <p>Manage provider and model lists. API keys are stored per provider.</p>

                  <section className="ai-config-section">
                    <div className="ai-config-head">
                      <h4>Provider List</h4>
                      <button className="ai-config-add-btn" onClick={addProviderPreset}>
                        <Plus size={14} /> Add
                      </button>
                    </div>
                    <div className="ai-config-list">
                      {providerPresets.map((provider) => (
                        <div key={provider.id} className="ai-provider-row">
                          <input
                            value={provider.name}
                            onChange={(event) =>
                              setProviderPresets((prev) =>
                                prev.map((item) => (item.id === provider.id ? { ...item, name: event.target.value } : item)),
                              )
                            }
                            placeholder="Provider name"
                          />
                          <CustomDropdown
                            className="ai-config-dropdown"
                            value={provider.providerType}
                            onChange={(nextType) =>
                              setProviderPresets((prev) =>
                                prev.map((item) =>
                                  item.id === provider.id
                                    ? { ...item, providerType: nextType as AIProviderSettings['providerType'] }
                                    : item,
                                ),
                              )
                            }
                            options={[
                              { value: 'openai', label: 'OpenAI' },
                              { value: 'gemini', label: 'Gemini' },
                              { value: 'compatible', label: 'Compatible' },
                            ]}
                          />
                          <input
                            value={provider.baseUrl}
                            onChange={(event) =>
                              setProviderPresets((prev) =>
                                prev.map((item) => (item.id === provider.id ? { ...item, baseUrl: event.target.value } : item)),
                              )
                            }
                            placeholder="Base URL (compatible)"
                          />
                          <input
                            type="password"
                            value={provider.apiKey}
                            onChange={(event) =>
                              setProviderPresets((prev) =>
                                prev.map((item) => (item.id === provider.id ? { ...item, apiKey: event.target.value } : item)),
                              )
                            }
                            placeholder="API key"
                          />
                          <button className="ai-config-remove-btn" onClick={() => removeProviderPreset(provider.id)}>
                            <CircleX size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="ai-config-section">
                    <div className="ai-config-head">
                      <h4>Model List</h4>
                      <button className="ai-config-add-btn" onClick={addModelPreset}>
                        <Plus size={14} /> Add
                      </button>
                    </div>
                    <div className="ai-config-list">
                      {modelPresets.map((model) => (
                        <div key={model.id} className="ai-model-row">
                          <input
                            value={model.name}
                            onChange={(event) =>
                              setModelPresets((prev) =>
                                prev.map((item) => (item.id === model.id ? { ...item, name: event.target.value } : item)),
                              )
                            }
                            placeholder="Model name"
                          />
                          <input
                            value={model.modelId}
                            onChange={(event) =>
                              setModelPresets((prev) =>
                                prev.map((item) => (item.id === model.id ? { ...item, modelId: event.target.value } : item)),
                              )
                            }
                            placeholder="Model ID"
                          />
                          <CustomDropdown
                            className="ai-config-dropdown"
                            value={model.providerId}
                            onChange={(nextProviderId) =>
                              setModelPresets((prev) =>
                                prev.map((item) => (item.id === model.id ? { ...item, providerId: nextProviderId } : item)),
                              )
                            }
                            options={providerPresets.map((provider) => ({
                              value: provider.id,
                              label: provider.name,
                            }))}
                            placeholder="Provider"
                          />
                          <button
                            className="ai-config-remove-btn"
                            onClick={() => setModelPresets((prev) => prev.filter((item) => item.id !== model.id))}
                          >
                            <CircleX size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>

                  <div className="settings-actions">
                    <button className="settings-secondary-btn" onClick={() => setSettingsOpen(false)}>
                      Cancel
                    </button>
                    <button className="settings-primary-btn" onClick={() => void saveAIConfiguration()}>
                      <Check size={14} /> Save AI settings
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      ) : null}

      {modal ? (
        <div className="app-modal-backdrop" onClick={modal.kind === 'confirm' ? cancelConfirmModal : cancelTextModal}>
          <div className="app-modal" onClick={(event) => event.stopPropagation()}>
            <h3>{modal.title}</h3>
            {'message' in modal && modal.message ? <p>{modal.message}</p> : null}
            {modal.kind === 'text' ? (
              <input
                autoFocus
                value={modalInput}
                placeholder={modal.placeholder}
                onChange={(event) => setModalInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') confirmTextModal()
                  if (event.key === 'Escape') cancelTextModal()
                }}
              />
            ) : null}
            <div className="app-modal-actions">
              <button onClick={modal.kind === 'confirm' ? cancelConfirmModal : cancelTextModal}>
                Cancel
              </button>
              <button
                className={modal.kind === 'confirm' && modal.danger ? 'danger' : ''}
                onClick={modal.kind === 'confirm' ? confirmConfirmModal : confirmTextModal}
              >
                {modal.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
