"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("accioBridgeDesktop", {
  launchAccio(params = {}) {
    return ipcRenderer.invoke("bridge:launch-accio", params);
  }
});
