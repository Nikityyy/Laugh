const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const { fork } = require("child_process");
const findFreePort = require("find-free-port");

let mainWindow;
let serverProcess;
let serverPort;

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
    icon: path.join(__dirname, "assets", "icon.ico"),
  });

  mainWindow.setMenu(null);

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      (input.control || input.meta) &&
      (input.key.toLowerCase() === "r" || input.key === "F5")
    ) {
      if (process.env.NODE_ENV !== "development") {
        // Allow refresh only in development
        event.preventDefault();
      }
    }
  });

  mainWindow.on("close", () => {});

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function startServer() {
  try {
    const [freePort] = await findFreePort(3030);
    serverPort = freePort;
    console.log(`[Main] Server will attempt to use port: ${serverPort}`);

    const serverPath = app.isPackaged
      ? path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "server",
          "server.js"
        ) // Corrected path
      : path.join(__dirname, "server", "server.js");

    console.log(`[Main] Server path: ${serverPath}`);

    // Check if server file exists, especially for packaged app
    const fs = require("fs");
    if (!fs.existsSync(serverPath)) {
      console.error(`[Main] Server file not found at: ${serverPath}`);
      throw new Error(`Server file not found at: ${serverPath}`);
    }

    serverProcess = fork(serverPath, [], {
      env: {
        ...process.env,
        PORT: serverPort,
        // API keys are now set via UI, so no need to pass them here from main process env
      },
      silent: true, // changed from false to true to capture stdout/stderr streams
    });

    serverProcess.stdout.on("data", (data) => {
      console.log(`[Server STDOUT] ${data.toString().trim()}`);
    });
    serverProcess.stderr.on("data", (data) => {
      console.error(`[Server STDERR] ${data.toString().trim()}`);
    });

    serverProcess.on("message", (message) => {
      if (message === "server-ready" && mainWindow) {
        console.log(
          `[Main] Received 'server-ready' from server on port ${serverPort}. Sending to renderer.`
        );
        mainWindow.webContents.send("server-port", serverPort);
      }
    });

    serverProcess.on("error", (err) => {
      console.error("[Main] Failed to start server process:", err);
    });

    serverProcess.on("exit", (code, signal) => {
      console.error(
        `[Main] Server process exited with code: ${code}, signal: ${signal}`
      );
      serverProcess = null;
      // Optionally, inform the renderer that the server has stopped
      if (mainWindow) {
        mainWindow.webContents.send("server-port", null); // Indicate server is down
      }
    });
  } catch (err) {
    console.error("[Main] Error finding free port or starting server:", err);
    // Notify user or quit gracefully
    if (mainWindow) {
      mainWindow.webContents.send(
        "display-error",
        `Failed to start backend server: ${err.message}`
      );
    }
    // Consider not auto-quitting if window is up, let user see error.
    // app.quit();
  }
}

app.on("ready", async () => {
  await startServer();
  createWindow();

  globalShortcut.register("Control+Q", () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.setSkipTaskbar(true);
      mainWindow.hide();
    } else if (mainWindow) {
      mainWindow.setSkipTaskbar(false);
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (serverProcess) {
    console.log("[Main] Killing server process on will-quit.");
    serverProcess.kill();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    // It's good practice to also ensure server is started if activate recreates window
    // and server might have died or wasn't started.
    if (!serverProcess) {
      startServer()
        .then(createWindow)
        .catch((err) =>
          console.error("Failed to restart server on activate:", err)
        );
    } else {
      createWindow();
    }
  }
});

ipcMain.handle("get-server-port", async (event) => {
  if (event.sender !== mainWindow.webContents) return null;
  // Only return port if server process is active and port is set
  if (serverProcess && serverPort) {
    return serverPort;
  }
  return null; // Or wait for serverPort to be set with a timeout
});

// It's generally better to log these and try to recover or inform the user
// rather than just quitting, especially for unhandledRejection.
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  // Log to a file or analytics service
  // Optionally, inform the user via a dialog before quitting
  // app.quit();
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason, "Promise:", promise);
  // app.quit();
});
