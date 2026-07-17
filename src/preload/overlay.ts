import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('overlayApi', {
  cancel: () => ipcRenderer.invoke('overlay:cancel'),
  confirm: (
    rect: { x: number; y: number; width: number; height: number },
    mode: 'region' | 'scroll'
  ) => ipcRenderer.invoke('overlay:confirm', rect, mode),
  onStart: (cb: (payload: { mode: 'region' | 'scroll' }) => void) => {
    const listener = (_: unknown, payload: { mode: 'region' | 'scroll' }): void => cb(payload)
    ipcRenderer.on('overlay:start', listener)
    return () => ipcRenderer.removeListener('overlay:start', listener)
  }
})
