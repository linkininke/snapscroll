import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('scrollBarApi', {
  finish: () => ipcRenderer.invoke('scroll-bar:finish'),
  cancel: () => ipcRenderer.invoke('scroll-bar:cancel'),
  onFrameCount: (cb: (count: number) => void) => {
    const listener = (_: unknown, count: number): void => cb(count)
    ipcRenderer.on('scroll-bar:frames', listener)
    return () => ipcRenderer.removeListener('scroll-bar:frames', listener)
  }
})
