import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/overlay.css'

type Mode = 'region' | 'scroll'
type Point = { sx: number; sy: number; cx: number; cy: number }
type ScreenRect = { x: number; y: number; width: number; height: number }
type RectPx = {
  left: number
  top: number
  width: number
  height: number
  x: number
  y: number
  w: number
  h: number
  kind: 'window' | 'custom'
}

const DRAG_THRESHOLD = 8

function IconShot(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 12.5l2.5 2.5L16 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconScroll(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="6" y="3" width="12" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 7v10M9.5 9.5L12 7l2.5 2.5M9.5 14.5L12 17l2.5-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function toClientRect(r: ScreenRect): Pick<RectPx, 'left' | 'top' | 'width' | 'height'> {
  return {
    left: r.x - window.screenX,
    top: r.y - window.screenY,
    width: r.width,
    height: r.height
  }
}

function OverlayApp(): React.JSX.Element {
  const [hintMode, setHintMode] = useState<Mode>('region')
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point | null>(null)
  const [finished, setFinished] = useState<RectPx | null>(null)
  const [hoverWindow, setHoverWindow] = useState<ScreenRect | null>(null)
  const dragging = useRef(false)
  const moved = useRef(false)
  const hoverReq = useRef(0)
  const lastHoverAt = useRef(0)

  const reset = (): void => {
    setStart(null)
    setCurrent(null)
    setFinished(null)
    dragging.current = false
    moved.current = false
  }

  const refreshHover = (sx: number, sy: number): void => {
    const now = Date.now()
    if (now - lastHoverAt.current < 40) return
    lastHoverAt.current = now
    const id = ++hoverReq.current
    void window.overlayApi.windowAt({ x: sx, y: sy }).then((rect) => {
      if (id !== hoverReq.current) return
      if (dragging.current || finished) return
      setHoverWindow(rect)
    })
  }

  useEffect(() => {
    return window.overlayApi.onStart((p) => {
      setHintMode(p.mode)
      reset()
      setHoverWindow(null)
      const cx = p.cursor?.x ?? window.screenX + window.innerWidth / 2
      const cy = p.cursor?.y ?? window.screenY + window.innerHeight / 2
      refreshHover(cx, cy)
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        void window.overlayApi.cancel()
        return
      }
      if (!finished) return
      if (e.key === 'Enter') {
        void window.overlayApi.confirm(
          { x: finished.x, y: finished.y, width: finished.w, height: finished.h },
          'region'
        )
      }
      if (e.key === 's' || e.key === 'S') {
        void window.overlayApi.confirm(
          { x: finished.x, y: finished.y, width: finished.w, height: finished.h },
          'scroll'
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finished])

  const pointFromEvent = (e: React.PointerEvent): Point => ({
    sx: e.screenX,
    sy: e.screenY,
    cx: e.clientX,
    cy: e.clientY
  })

  const onPointerDown = (e: React.PointerEvent): void => {
    if (finished) {
      const target = e.target as HTMLElement
      if (target.closest('.action-bar')) return
      reset()
    }
    dragging.current = true
    moved.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = pointFromEvent(e)
    setStart(p)
    setCurrent(p)
    setFinished(null)
    refreshHover(p.sx, p.sy)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const p = pointFromEvent(e)
    if (!dragging.current) {
      refreshHover(p.sx, p.sy)
      return
    }
    if (start) {
      const dist = Math.hypot(p.sx - start.sx, p.sy - start.sy)
      if (dist >= DRAG_THRESHOLD) {
        moved.current = true
        setHoverWindow(null)
      }
    }
    setCurrent(p)
  }

  const finishWithScreenRect = (r: ScreenRect, kind: 'window' | 'custom'): void => {
    const client = toClientRect(r)
    setFinished({
      ...client,
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      kind
    })
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!dragging.current || !start) return
    dragging.current = false
    const end = pointFromEvent(e)
    setCurrent(end)

    // 未拖拽：截取鼠标下当前窗口（边缘扫描结果）
    if (!moved.current) {
      void window.overlayApi.windowAt({ x: start.sx, y: start.sy }).then((rect) => {
        if (rect) {
          setHoverWindow(null)
          finishWithScreenRect(rect, 'window')
          return
        }
        // 找不到窗口则取消，避免误截
        void window.overlayApi.cancel()
      })
      return
    }

    const x = Math.min(start.sx, end.sx)
    const y = Math.min(start.sy, end.sy)
    const w = Math.abs(end.sx - start.sx)
    const h = Math.abs(end.sy - start.sy)

    if (w < DRAG_THRESHOLD || h < DRAG_THRESHOLD) {
      void window.overlayApi.cancel()
      return
    }

    setHoverWindow(null)
    finishWithScreenRect({ x, y, width: w, height: h }, 'custom')
  }

  const liveCustom =
    dragging.current && moved.current && start && current
      ? {
          left: Math.min(start.cx, current.cx),
          top: Math.min(start.cy, current.cy),
          width: Math.abs(current.cx - start.cx),
          height: Math.abs(current.cy - start.cy)
        }
      : null

  const hoverClient = !finished && !moved.current && hoverWindow ? toClientRect(hoverWindow) : null
  const rect = finished
    ? { left: finished.left, top: finished.top, width: finished.width, height: finished.height }
    : liveCustom ?? hoverClient

  const confirm = (mode: Mode): void => {
    if (!finished) return
    void window.overlayApi.confirm(
      { x: finished.x, y: finished.y, width: finished.w, height: finished.h },
      mode
    )
  }

  const barStyle = finished
    ? {
        left: Math.min(finished.left + finished.width - 8, window.innerWidth - 96),
        top: Math.min(finished.top + finished.height + 8, window.innerHeight - 48)
      }
    : undefined

  const hint = finished
    ? finished.kind === 'window'
      ? '已选中当前窗口 · 点右下角截图/长截图 · Esc 取消'
      : '自定义选区 · 点右下角截图/长截图 · Esc 取消'
    : '移到微信等窗口上看边缘高亮 · 单击截当前窗口 · 拖拽才自定义 · Esc 取消'

  return (
    <div
      className="mask"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="hint">{hint}</div>

      {rect ? (
        <div
          className={`selection${finished?.kind === 'window' || (!finished && hoverClient) ? ' window-edge' : ''}`}
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          }}
        >
          <span className="size">
            {!finished && hoverClient && !moved.current ? '窗口 ' : ''}
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      ) : null}

      {finished && barStyle ? (
        <div className="action-bar" style={barStyle} onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`icon-btn${hintMode === 'region' ? ' preferred' : ''}`}
            title="区域截图"
            onClick={() => confirm('region')}
          >
            <IconShot />
          </button>
          <button
            type="button"
            className={`icon-btn${hintMode === 'scroll' ? ' preferred' : ''}`}
            title="长截图（开始后可自由滚动，再点一次完成）"
            onClick={() => confirm('scroll')}
          >
            <IconScroll />
          </button>
        </div>
      ) : null}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>
)
