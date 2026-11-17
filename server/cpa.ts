import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface AuthFile {
  name: string;
  auth_index: string;
  provider?: string;
  account_type?: string;
  label?: string;
  email?: string;
  note?: string;
  disabled?: boolean;
  id_token?: { chatgpt_account_id?: string; plan_type?: string };
}

interface Connection {
  baseUrl: string;
  key: string;
  via: string;
}

const read = (path: string) => readFile(path, "utf8").catch(() => "");
const pick = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];

/** Stays under Paseo's 20-second per-login deadline. */
function deadline(ms: number) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Directories of running CPA / EasyCLIProxyAPI executables. */
async function processDirs(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='cli-proxy-api.exe' or Name='EasyCLIProxyAPI.exe'\" | ForEach-Object ExecutablePath",
    ],
    { windowsHide: true, timeout: 15_000 },
  );
  return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(dirname))];
}

async function request<T>(conn: Pick<Connection, "baseUrl" | "key">, path: string, body?: unknown) {
  const res = await fetch(`${conn.baseUrl}/v0/management/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${conn.key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: deadline(18_000),
  });
  if (!res.ok) throw Object.assign(new Error(`CPA management API ${path}: HTTP ${res.status}`), { status: res.status });
  return (await res.json()) as T;
}

/**
 * Finds the CPA server from the running process and its local config files, then picks the first
 * Management Key candidate CPA accepts. The key stays in this daemon subprocess.
 */
async function discover(): Promise<Connection> {
  const envKey = process.env.CPA_MANAGEMENT_KEY || process.env.MANAGEMENT_PASSWORD;
  const dirs = (await processDirs().catch(() => [])).flatMap((dir) => [dir, dirname(dir)]);
  const candidates: Connection[] = [];
  for (const dir of [...new Set(dirs)]) {
    const toml = await read(join(dir, "config.toml"));
    const yaml = await read(join(dir, "config.yaml"));
    if (!toml && !yaml) continue;
    let host = pick(toml, /^host\s*=\s*"([^"]*)"/m) || "127.0.0.1";
    if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
    const port = pick(toml, /^port\s*=\s*(\d+)/m) ?? pick(yaml, /^\s*port:\s*(\d+)/m) ?? "8317";
    const tls = /^\s*tls:\s*\n\s*enable:\s*true/m.test(yaml);
    const baseUrl = `${tls ? "https" : "http"}://${host}:${port}`;
    const keys = [
      envKey && { key: envKey, via: "environment" },
      { key: pick(toml, /^management-secret-key\s*=\s*"([^"]+)"/m), via: join(dir, "config.toml") },
      { key: pick(yaml, /^\s+secret-key:\s*"?([^"\s#]+)"?/m), via: join(dir, "config.yaml") },
    ];
    for (const entry of keys) {
      if (entry && entry.key && !entry.key.startsWith("$2")) candidates.push({ baseUrl, key: entry.key, via: entry.via });
    }
  }
  if (envKey) candidates.push({ baseUrl: "http://127.0.0.1:8317", key: envKey, via: "environment" });
  if (!candidates.length) throw new Error("CPA not found: no running cli-proxy-api.exe with a readable Management Key");
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await request(candidate, "auth-files");
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

let connection: Promise<Connection> | undefined;
let files: { at: number; value: Promise<AuthFile[]> } | undefined;

export function connect(force = false): Promise<Connection> {
  if (force || !connection) {
    connection = discover();
    connection.catch(() => (connection = undefined));
  }
  return connection;
}

/** OAuth accounts in the CPA pool, cached for 30 seconds. */
export function listAccounts(force = false): Promise<AuthFile[]> {
  if (force || !files || Date.now() - files.at > 30_000) {
    const value = connect(force)
      .then((conn) => request<{ files: AuthFile[] }>(conn, "auth-files"))
      .then(({ files }) =>
        files.filter((file) =>
          file.account_type ? file.account_type === "oauth" : !!file.provider && file.provider !== "unknown",
        ),
      );
    value.catch(() => {
      files = undefined;
      connection = undefined;
    });
    files = { at: Date.now(), value };
  }
  return files.value;
}

/** Calls an upstream URL with the account's token through CPA; `$TOKEN$` is substituted by CPA. */
export async function apiCall(authIndex: string, url: string, header: Record<string, string>) {
  const res = await request<{ status_code: number; body: unknown }>(await connect(), "api-call", {
    auth_index: authIndex,
    method: "GET",
    url,
    header,
  });
  let body = res.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  return { status: res.status_code, body };
}
