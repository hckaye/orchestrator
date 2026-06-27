// Preload bridge (CommonJS — Electron contextIsolation)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orchestrator", {
  listWorkers: () => ipcRenderer.invoke("workers:list"),
  getDetail: (id) => ipcRenderer.invoke("workers:detail", id),
  getLog: (id, opts) => ipcRenderer.invoke("workers:log", id, opts),
  listProcesses: () => ipcRenderer.invoke("processes:list"),
  openPath: (p) => ipcRenderer.invoke("shell:openPath", p),
  showItem: (p) => ipcRenderer.invoke("shell:showItem", p),
  getInfo: () => ipcRenderer.invoke("app:getInfo"),
  sendMessage: (id, message, opts) =>
    ipcRenderer.invoke("workers:sendMessage", id, message, opts || {}),
  pingWorker: (id) => ipcRenderer.invoke("workers:ping", id),
  revise: (id, feedback) => ipcRenderer.invoke("workers:revise", id, feedback),
  resume: (id, message) => ipcRenderer.invoke("workers:resume", id, message || ""),
  forceFail: (id) => ipcRenderer.invoke("workers:forceFail", id),
  archive: (id) => ipcRenderer.invoke("workers:archive", id),

  onWorkersUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("workers:update", handler);
    return () => ipcRenderer.removeListener("workers:update", handler);
  },
  onProcessesUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("processes:update", handler);
    return () => ipcRenderer.removeListener("processes:update", handler);
  },
});
