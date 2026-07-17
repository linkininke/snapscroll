import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/overlay.css'

type Mode = 'region' | 'scroll'
type Point = { sx: number; sy: number; cx: number; cy: number }
type RectPx = { left: number; top: number; width: number; height: number; x: number; y: number; w: number; h: number }

function IconShot(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 12.5l2.5 2.5L16 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconScroll(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="6" y="3" width="12" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7v10M9.5 9.5L12 7l2.5 2.5M9.5 14.5L12 17l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function OverlayApp(): React.JSX.Element {
  const [hintMode, setHintMode] = useState<Mode>('region')
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point | null>(null)
  const [finished, setFinished] = useState<RectPx | null>(null)
  const dragging = useRef(false)

  const reset = (): void => {
    setStart(null)
    setCurrent(null)
    setFinished(null)
    dragging.current = false
  }

  useEffect(() => {
    return window.overlayApi.onStart((p) => {
      setHintMode(p.mode)
      reset()
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
      // 点在工具栏外则取消重选
      const target = e.target as HTMLElement
      if (target.closest('.action-bar')) return
      reset()
    }
    dragging.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = pointFromEvent(e)
    setStart(p)
    setCurrent(p)
    setFinished(null)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragging.current) return
    setCurrent(pointFromEvent(e))
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!dragging.current || !start) return
    dragging.current = false
    const end = pointFromEvent(e)
    const x = Math.min(start.sx, end.sx)
    const y = Math.min(start.sy, end.sy)
    const w = Math.abs(end.sx - start.sx)
    const h = Math.abs(end.sy - start.sy)

    if (w < 8 || h < 8) {
      void window.overlayApi.cancel()
      return
    }

    setFinished({
      left: Math.min(start.cx, end.cx),
      top: Math.min(start.cy, end.cy),
      width: Math.abs(end.cx - start.cx),
      height: Math.abs(end.cy - start.cy),
      x,
      y,
      w,
      h
    })
    setCurrent(end)
  }

  const liveRect =
    !finished && start && current
      ? {
          left: Math.min(start.cx, current.cx),
          top: Math.min(start.cy, current.cy),
          width: Math.abs(current.cx - start.cx),
          height: Math.abs(current.cy - start.cy)
        }
      : null

  const rect = finished ?? liveRect

  const confirm = (mode: Mode): void => {
    if (!finished) return
    void window.overlayApi.confirm(
      { x: finished.x, y: finished.y, width: finished.w, height: finished.h },
      mode
    )
  }

  // 工具条贴在选区右下角外侧，靠近屏幕边缘时往内收
  const barStyle = finished
    ? {
        left: Math.min(finished.left + finished.width - 8, window.innerWidth - 96),
        top: Math.min(finished.top + finished.height + 8, window.innerHeight - 48)
      }
    : undefined

  return (
    <div
      className="mask"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {!finished ? (
        <div className="hint">
          {hintMode === 'scroll' ? '拖拽选择滚动区域 · Esc 取消' : '拖拽选择截图区域 · Esc 取消'}
        </div>
      ) : (
        <div className="hint">点右下角：截图 / 长截图（开始）· Esc 取消</div>
      )}

      {rect ? (
        <div
          className="selection"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          }}
        >
          <span className="size">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      ) : null}

      {finished && barStyle ? (
        <div
          className="action-bar"
          style={barStyle}
          onPointerDown={(e) => e.stopPropagation()}
        >
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
