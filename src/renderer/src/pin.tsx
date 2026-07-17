import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/pin.css'

function IconCopy(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconSave(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M5 3h11l3 3v15H5V3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M8 3v6h8V3M8 21v-7h8v7" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function IconClose(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function IconZoomIn(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 15l4.5 4.5M10.5 8v5M8 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function IconZoomOut(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 15l4.5 4.5M8 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function PinApp(): React.JSX.Element {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const src = params.get('src') ?? ''
  const naturalW = Number(params.get('w')) || 0
  const naturalH = Number(params.get('h')) || 0
  const dpr = window.devicePixelRatio || 1
  // 物理像素 ÷ DPR = 屏幕 1:1 显示尺寸
  const displayW = naturalW > 0 ? naturalW / dpr : undefined
  const displayH = naturalH > 0 ? naturalH / dpr : undefined
  const fileUrl = src.startsWith('file:') ? src : `file://${src.replace(/\\/g, '/')}`

  // 1 = 100%；Ctrl+滚轮缩放，普通滚轮上下平移（长图浏览）
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const bodyRef = useRef<HTMLDivElement>(null)

  const clampScale = (v: number): number => Math.min(8, Math.max(0.2, v))

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onWheelNative = (e: WheelEvent): void => {
      e.preventDefault()
      // Ctrl+滚轮：缩放大小
      if (e.ctrlKey || e.metaKey) {
        const delta = e.deltaY > 0 ? -0.12 : 0.12
        setScale((s) => clampScale(Number((s + delta).toFixed(3))))
        return
      }
      // 普通滚轮：上下滚动浏览（长图）
      const dy = e.deltaY
      const dx = e.deltaX
      setOffset((o) => ({ x: o.x - dx, y: o.y - dy }))
    }
    el.addEventListener('wheel', onWheelNative, { passive: false })
    return () => el.removeEventListener('wheel', onWheelNative)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        void window.pinApi.close()
        return
      }
      if (e.key === '=' || e.key === '+') {
        setScale((s) => clampScale(s + 0.15))
      } else if (e.key === '-') {
        setScale((s) => clampScale(s - 0.15))
      } else if (e.key === '0') {
        setScale(1)
        setOffset({ x: 0, y: 0 })
      } else if (e.key === 'ArrowUp') {
        setOffset((o) => ({ ...o, y: o.y + 80 }))
      } else if (e.key === 'ArrowDown') {
        setOffset((o) => ({ ...o, y: o.y - 80 }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    dragging.current = true
    lastPos.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragging.current) return
    const dx = e.clientX - lastPos.current.x
    const dy = e.clientY - lastPos.current.y
    lastPos.current = { x: e.clientX, y: e.clientY }
    setOffset((o) => ({ x: o.x + dx, y: o.y + dy }))
  }

  const onPointerUp = (): void => {
    dragging.current = false
  }

  const onDoubleClick = (): void => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  const save = async (): Promise<void> => {
    await window.pinApi.saveAs(src)
  }

  const imgStyle: React.CSSProperties = {
    width: displayW,
    height: displayH,
    maxWidth: 'none',
    maxHeight: 'none',
    transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
    transformOrigin: 'center center'
  }

  return (
    <div className="pin">
      <div className="drag-area" />
      <div
        className="body"
        ref={bodyRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        {src ? (
          <img src={fileUrl} alt="screenshot" draggable={false} style={imgStyle} />
        ) : (
          <div>无图片</div>
        )}
      </div>

      <div className="zoom-badge" title="滚轮上下 · Ctrl+滚轮缩放 · Esc 退出">
        {Math.round(scale * 100)}%
      </div>

      <div className="corner-bar" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="icon-btn"
          title="缩小（Ctrl+滚轮 / -）"
          onClick={() => setScale((s) => clampScale(s - 0.15))}
        >
          <IconZoomOut />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="放大（Ctrl+滚轮 / +）"
          onClick={() => setScale((s) => clampScale(s + 0.15))}
        >
          <IconZoomIn />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="复制并关闭"
          onClick={() => {
            void window.pinApi.copy(src).then(() => void window.pinApi.close())
          }}
        >
          <IconCopy />
        </button>
        <button type="button" className="icon-btn" title="保存" onClick={() => void save()}>
          <IconSave />
        </button>
        <button type="button" className="icon-btn" title="关闭（Esc）" onClick={() => void window.pinApi.close()}>
          <IconClose />
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PinApp />
  </StrictMode>
)
