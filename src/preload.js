const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getServerPort: () => ipcRenderer.invoke("get-server-port"),
  onServerPort: (callback) =>
    ipcRenderer.on("server-port", (_event, port) => callback(port)),
});
