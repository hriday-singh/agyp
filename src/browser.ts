/**
 * Send agy's OAuth page to a throwaway Chrome guest window instead of your
 * normal browser.
 *
 * agy opens URLs the way every Go CLI does (github.com/pkg/browser): it shells
 * out to `rundll32 url.dll,FileProtocolHandler <url>` on Windows and `xdg-open`
 * / `open` elsewhere — all three resolved through PATH. So we do not need agy's
 * cooperation: we write a tiny shim with one of those names into a temp dir,
 * put that dir first on PATH for the child process, and the shim launches
 * Chrome in guest mode with the URL.
 *
 * Guest mode matters because agy's sign-in is a normal Google web session: in
 * your default browser it picks up whichever account is already signed in, and
 * leaves the new one signed in there afterwards. A guest window shares no
 * cookies with your profile in either direction.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => p && existsSync(p)) ?? null;
}

/** Absolute path to a Chrome-family browser, or null if none is installed. */
export function chromePath(): string | null {
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']];
    return firstExisting(
      roots.filter(Boolean).map((r) => join(r as string, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    );
  }
  if (process.platform === 'darwin') {
    return firstExisting([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${process.env['HOME']}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    const path = r.stdout?.split('\n')[0]?.trim();
    if (r.status === 0 && path) return path;
  }
  return null;
}

/**
 * Environment for a child agy that opens links in a Chrome guest window.
 * Returns null (caller falls back to the default browser) when Chrome is absent.
 */
export function guestBrowserEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | null {
  const chrome = chromePath();
  if (!chrome) return null;

  const dir = mkdtempSync(join(tmpdir(), 'agyp-browser-'));
  if (process.platform === 'win32') {
    // pkg/browser calls: rundll32 url.dll,FileProtocolHandler <url>  -> %2 is the URL.
    // OAuth URLs are full of `&`, so it has to stay quoted through cmd.
    writeFileSync(join(dir, 'rundll32.cmd'), `@echo off\r\nstart "" "${chrome}" --guest "%~2"\r\n`);
  } else {
    // ponytail: one shim per name pkg/browser tries; whichever it picks, it lands here.
    const script = `#!/bin/sh\nexec "${chrome}" --guest "$1" >/dev/null 2>&1 &\n`;
    for (const name of ['xdg-open', 'open', 'x-www-browser', 'www-browser']) {
      const file = join(dir, name);
      writeFileSync(file, script);
      chmodSync(file, 0o755);
    }
  }
  return { ...env, PATH: `${dir}${delimiter}${env['PATH'] ?? ''}` };
}
