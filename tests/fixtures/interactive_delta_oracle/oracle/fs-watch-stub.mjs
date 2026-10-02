// fs-watch seam: the theme reload watcher is presentation (D1) and never runs
// in the capture (enableWatcher paths are not exercised).
export function closeWatcher() {}

export function watchWithErrorHandler() {
	return undefined;
}
