import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/scroll-bar.css'

/** 与第一次选区栏里的「长截图」图标一致 */
function IconScrollDone(): React.JSX.Element {
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

function ScrollBarApp(): React.JSX.Element {
  const [frames, setFrames] = useState(1)

  useEffect(() => {
    return window.scrollBarApi.onFrameCount(setFrames)
  }, [])

  return (
    <div className="action-bar" title="完成长截图（或再按 F1）">
      <span className="count" title="已捕获帧数">
        {frames}
      </span>
      <button
        type="button"
        className="icon-btn preferred"
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
