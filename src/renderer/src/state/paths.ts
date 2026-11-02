// ~/Runbooks rather than /home/someone/Runbooks, for showing a folder.
export function withTilde(path: string): string {
  return path.replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}
