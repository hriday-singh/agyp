/**
 * Cross-platform OS keyring access.
 *
 * Every secret this tool touches lives in the OS keyring — both the live `agy`
 * credential and our saved profiles. Nothing secret is ever written to disk.
 *
 * The (service, account) -> backend mapping matches how `agy` (Go, via
 * zalando/go-keyring) stores its own credential, so we can read and write the
 * exact same entry it does:
 *
 *   Windows  Credential Manager, generic credential, TargetName `service:account`
 *   Linux    Secret Service (libsecret), attributes {service, username}
 *   macOS    Keychain generic password, -s service -a account
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export class KeyringError extends Error {}

/** PowerShell + inline C# P/Invoke. Windows has no CLI that can read a credential blob. */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AgypCred {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string t, uint ty, uint f, out IntPtr c);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWriteW(ref CREDENTIAL c, uint f);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDeleteW(string t, uint ty, uint f);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr b);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize);
      return b;
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, byte[] blob) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = (uint)blob.Length;
    IntPtr h = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, h, blob.Length);
      c.CredentialBlob = h;
      if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(h); }
  }
  public static bool Delete(string target) { return CredDeleteW(target, 1, 0); }
}
"@
switch ($env:AGYP_ACTION) {
  'read' {
    $b = [AgypCred]::Read($env:AGYP_TARGET)
    if ($null -eq $b) { Write-Output 'NULL' } else { Write-Output ([Convert]::ToBase64String($b)) }
  }
  'write' {
    $in = [Console]::In.ReadToEnd().Trim()
    [AgypCred]::Write($env:AGYP_TARGET, $env:AGYP_USER, [Convert]::FromBase64String($in))
    Write-Output 'OK'
  }
  'delete' {
    $null = [AgypCred]::Delete($env:AGYP_TARGET)
    Write-Output 'OK'
  }
}
`;

/** Windows Credential Manager target name, same scheme go-keyring uses. */
export function winTarget(service: string, account: string): string {
  return `${service}:${account}`;
}

function fail(what: string, r: SpawnSyncReturns<string>): never {
  const detail = (r.stderr || r.stdout || r.error?.message || '').trim();
  throw new KeyringError(`${what}: ${detail || `exit ${r.status}`}`);
}

// ponytail: one PowerShell spawn per operation (~400ms of Add-Type). A CLI does a
// handful of these per run. Swap for a native module only if that ever matters.
function ps(action: 'read' | 'write' | 'delete', target: string, account: string, secret?: string) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
    {
      input: secret === undefined ? '' : Buffer.from(secret, 'utf8').toString('base64'),
      env: { ...process.env, AGYP_ACTION: action, AGYP_TARGET: target, AGYP_USER: account },
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

function run(cmd: string, args: string[], input?: string) {
  return spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

function missingBackend(cmd: string): KeyringError {
  const hint =
    cmd === 'secret-tool'
      ? 'install libsecret-tools (Debian/Ubuntu: apt install libsecret-tools, Fedora: dnf install libsecret) and make sure a keyring daemon (gnome-keyring / kwallet) is running'
      : `${cmd} not found on PATH`;
  return new KeyringError(`keyring backend unavailable: ${hint}`);
}

export function get(service: string, account: string): string | null {
  if (process.platform === 'win32') {
    const r = ps('read', winTarget(service, account), account);
    if (r.status !== 0) fail('credential read failed', r);
    const out = r.stdout.trim();
    return out === 'NULL' ? null : Buffer.from(out, 'base64').toString('utf8');
  }
  if (process.platform === 'darwin') {
    const r = run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    if (r.error) throw missingBackend('security');
    if (r.status !== 0) return null; // 44 = not found
    return r.stdout.replace(/\n$/, '');
  }
  const r = run('secret-tool', ['lookup', 'service', service, 'username', account]);
  if (r.error) throw missingBackend('secret-tool');
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n$/, '');
}

export function set(service: string, account: string, secret: string): void {
  if (secret.includes('\n')) throw new KeyringError('secret must be single-line');
  if (process.platform === 'win32') {
    const r = ps('write', winTarget(service, account), account, secret);
    if (r.status !== 0) fail('credential write failed', r);
    return;
  }
  if (process.platform === 'darwin') {
    // ponytail: `security` has no stdin path for the password, so it lands in argv
    // and is briefly visible to `ps`. macOS is best-effort here; Windows/Linux are not.
    const r = run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret]);
    if (r.error) throw missingBackend('security');
    if (r.status !== 0) fail('keychain write failed', r);
    return;
  }
  const r = run(
    'secret-tool',
    ['store', '--label', `${service}:${account}`, 'service', service, 'username', account],
    `${secret}\n`,
  );
  if (r.error) throw missingBackend('secret-tool');
  if (r.status !== 0) fail('secret-tool store failed', r);
}

export function del(service: string, account: string): void {
  if (process.platform === 'win32') {
    const r = ps('delete', winTarget(service, account), account);
    if (r.status !== 0) fail('credential delete failed', r);
    return;
  }
  if (process.platform === 'darwin') {
    run('security', ['delete-generic-password', '-s', service, '-a', account]);
    return;
  }
  run('secret-tool', ['clear', 'service', service, 'username', account]);
}

/** True when the platform's keyring backend is reachable. Used by `agyp doctor`. */
export function backendAvailable(): { ok: boolean; detail: string } {
  try {
    get('agy-profiler', '_probe');
    return { ok: true, detail: backendName() };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function backendName(): string {
  if (process.platform === 'win32') return 'Windows Credential Manager';
  if (process.platform === 'darwin') return 'macOS Keychain';
  return 'Secret Service (libsecret)';
}
