// The renderer's run tracker (state/run-tracker.ts), wired to window.api and to xterm
// output panes. Components import the store and the actions from here.

import { createRunTracker } from "../state/run-tracker";
import { OutputPane } from "./output-pane";

const tracker = createRunTracker(window.api, (callbacks) => new OutputPane(callbacks));

export const {
  runs,
  existingPane,
  paneFor,
  runCell,
  stopCell,
  closeSession,
  forgetCell,
  renameRunbook: renameRuns,
  forgetRunbook: forgetRuns,
  forgetAll: forgetAllRuns,
  claimPath,
} = tracker;

// Subscribes to the main process's events, once, for the window's lifetime.
export function trackRuns(): void {
  tracker.start();
}
