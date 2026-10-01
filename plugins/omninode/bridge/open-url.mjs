import { execFile as nodeExecFile } from "node:child_process";

// Shared by the OAuth login redirect and the Room viewer. execFile with an
// argv array — never a shell string — so the URL cannot be interpreted as
// shell syntax.
export function openInBrowser(url) {
  return new Promise((resolve) => {
    nodeExecFile("/usr/bin/open", [url], () => resolve());
  });
}
