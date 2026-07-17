import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/scroll-bar.css'

function IconScrollDone(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="6" y="3" width="12" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 7v10M9.5 9.5L12 7l2.5 2.5M9.5 14.5L12 17l2.5-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.5 8.5l1.8 1.8L21 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ScrollBarApp(): React.JSX.Element {
  const [frames, setFrames] = useState(1)

  useEffect(() => {
    return window.scrollBarApi.onFrameCount(setFrames)
  }, [])

  return (
    <div className="bar">
      <div className="meta">
        <div className="title">连续长截图中</div>
        <div className="sub">请匀速向下滚动 · 边滚边截 · 完成后点图标</div>
      </div>
      <span className="count">{frames}</span>
      <button
        type="button"
        className="finish-icon"
        title="完成长截图"
        onClick={() => void window.scrollBarApi.finish()}
      >
        <IconScrollDone />
      </button>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ScrollBarApp />
  </StrictMode>
)
