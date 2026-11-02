import { join } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import { registerIpc } from "./ipc";
import { ensureRunbooksDir } from "./runbooks";
import { defaultSettings, loadSettings } from "./settings";
import { SessionManager } from "./shell/manager";
import { githubSource, startAfterExit, Updater, updatesEnabled } from "./updater";
import { createWindow } from "./window";
import { loadWindowState } from "./window-state";

// Name the data folder after the app ID (~/.config/codes.mhd.runbook) rather than
// the generic product name. Must match appId in electron-builder.yml, and must run
// before anything touches userData, including the single-instance lock below.
const APP_ID = "codes.mhd.runbook";
app.setPath("userData", join(app.getPath("appData"), APP_ID));

// The app is dark only; this also darkens native menus and dialogs.
nativeTheme.themeSource = "dark";

// Block in-page navigation away from the app.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  const sessions = new SessionManager({
    rcfilePath: join(app.getPath("userData"), "rcfile.bash"),
  });

  // Set at startup when this AppImage can update itself.
  let updater: Updater | null = null;
  let restartAfterQuit = false;

  // Kill the shells and remove the run scripts' temp folder before quitting. Then put a
  // downloaded update in place: the windows have closed by now, so edits are saved.
  let quitting = false;
  app.on("will-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void sessions
      .dispose()
      .catch((error: unknown) => console.error("Could not clean up shell sessions:", error))
      .finally(() => {
        updater?.install();
        // If the install failed, that's the old version again.
        const appImage = process.env["APPIMAGE"];
        if (restartAfterQuit && appImage) {
          try {
            startAfterExit(appImage);
          } catch (error) {
            console.error("Could not restart Runbook:", error);
          }
        }
        app.quit();
      });
  });

  void app
    .whenReady()
    .then(async () => {
      // Any failure here must still end in a window: a windowless app never quits and
      // keeps the single-instance lock, so the app could not be started again.
      // The window state is read meanwhile; nothing before the window needs it.
      const windowStateFile = join(app.getPath("userData"), "window-state.json");
      const windowState = loadWindowState(windowStateFile).catch((error: unknown) => {
        console.error("Could not load the window state:", error);
        return null;
      });
      const settings = await loadSettings(join(app.getPath("userData"), "settings.json")).catch(
        (error: unknown) => {
          console.error("Could not load settings, using defaults:", error);
          return defaultSettings();
        },
      );
      await ensureRunbooksDir(settings.runbooksDir).catch((error: unknown) => {
        console.error("Could not prepare the runbooks folder:", error);
      });
      const appImage = process.env["APPIMAGE"];
      if (
        appImage &&
        updatesEnabled({
          isPackaged: app.isPackaged,
          appImage,
          checkForUpdates: settings.checkForUpdates,
        })
      ) {
        updater = await githubSource()
          .then((source) => new Updater(source, appImage))
          .catch((error: unknown) => {
            console.error("Could not set up updates:", error);
            return null;
          });
      }
      registerIpc(settings, sessions, updater, () => {
        restartAfterQuit = true;
      });

      createWindow(await windowState, windowStateFile);
      // Once the window is up, so the check never holds up the start.
      const started = updater;
      if (started) setTimeout(() => void started.check(), 5000);
    })
    // Startup failed in a way the steps above don't handle: quit rather than run on
    // with no window, which would keep the lock.
    .catch((error: unknown) => {
      console.error("Could not start Runbook:", error);
      app.quit();
    });

  app.on("window-all-closed", () => app.quit());
}
