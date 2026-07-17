import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('snapscroll', {
  getHotkeys: () => ipcRenderer.invoke('app:get-hotkeys'),
  openCaptureDir: () => ipcRenderer.invoke('app:open-capture-dir'),
  startRegion: () => ipcRenderer.invoke('app:start-region'),
  startScroll: () => ipcRenderer.invoke('app:start-scroll'),
  onCaptureDone: (cb: (payload: { filePath: string; mode: string }) => void) => {
    const listener = (_: unknown, payload: { filePath: string; mode: string }): void => cb(payload)
    ipcRenderer.on('capture:done', listener)
    return () => ipcRenderer.removeListener('capture:done', listener)
  },
  onCaptureStatus: (cb: (payload: { status: string }) => void) => {
    const listener = (_: unknown, payload: { status: string }): void => cb(payload)
    ipcRenderer.on('capture:status', listener)
    return () => ipcRenderer.removeListener('capture:status', listener)
  },
  onCaptureError: (cb: (payload: { message: string }) => void) => {
    const listener = (_: unknown, payload: { message: string }): void => cb(payload)
    ipcRenderer.on('capture:error', listener)
    return () => ipcRenderer.removeListener('capture:error', listener)
  }
})
