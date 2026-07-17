import { useEffect, useState } from 'react'

type Hotkeys = { capture: string; fullscreen: string }

export default function App(): React.JSX.Element {
  const [hotkeys, setHotkeys] = useState<Hotkeys>({
    capture: 'F1',
    fullscreen: 'F2'
  })
  const [status, setStatus] = useState('就绪 · 关闭窗口后仍在托盘运行')
  const [lastFile, setLastFile] = useState<string | null>(null)

  useEffect(() => {
    void window.snapscroll.getHotkeys().then(setHotkeys)
    const offDone = window.snapscroll.onCaptureDone((p) => {
      setStatus(p.mode === 'scroll' ? '长截图已贴图（滚轮可缩放）' : '截图已贴图（滚轮可缩放）')
      setLastFile(p.filePath)
    })
    const offStatus = window.snapscroll.onCaptureStatus((p) => {
      if (p.status === 'scrolling') setStatus('连续长截图中：随意滚动，完成后点图标')
      if (p.status === 'stitching') setStatus('正在拼接…')
      if (p.status === 'cancelled') setStatus('已取消长截图')
    })
    const offErr = window.snapscroll.onCaptureError((p) => {
      setStatus(`失败：${p.message}`)
    })
    return () => {
      offDone()
      offStatus()
      offErr()
    }
  }, [])

  return (
    <div className="app">
      <header className="hero">
        <div className="brand">截图助手</div>
        <p className="tagline">区域截图 · 任意窗口长截图 · 保存至 E:\截图文件</p>
      </header>

      <section className="panel">
        <h2>快捷键</h2>
        <ul className="hotkeys">
          <li>
            <span>截图（区域 / 长截图）</span>
            <kbd>{hotkeys.capture}</kbd>
          </li>
          <li>
            <span>全屏截图</span>
            <kbd>{hotkeys.fullscreen}</kbd>
          </li>
        </ul>
      </section>

      <section className="actions">
        <button type="button" className="btn primary" onClick={() => void window.snapscroll.startRegion()}>
          开始截图
        </button>
        <button type="button" className="btn ghost" onClick={() => void window.snapscroll.openCaptureDir()}>
          打开保存目录
        </button>
      </section>

      <p className="tip">右下角托盘图标可右键呼出菜单；关闭本窗口不会退出。</p>

      <footer className="status">
        <div>{status}</div>
        {lastFile ? <div className="path" title={lastFile}>{lastFile}</div> : null}
      </footer>
    </div>
  )
}
