#!/usr/bin/env bun
/**
 * fpd-web — lmfpd 的本地图形界面（实时终端版）
 *
 * 与上一版的区别：
 *  - 用 PTY 跑 lmfpd 的 Ink TUI，把 ANSI 原样流给浏览器，由前端做终端回放 + 高亮
 *  - 不再解析 --json（也就没有"等结束才出结果"的卡顿），进度、排名、结论都是它自己画的
 *  - 仍然保留 --output，报告 JSON 落盘留档，需要时原样查看
 *
 * 安全：key 走环境变量不进 argv；参数数组不拼 shell；只监听 127.0.0.1 + 校验 Host/Origin。
 */

import { chmod, mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = import.meta.dir;
const DATA_DIR = join(ROOT, "data");
const RUNS_DIR = join(ROOT, "runs");
const PUBLIC_DIR = join(ROOT, "public");
const PROVIDERS_FILE = join(DATA_DIR, "providers.json");

const PORT = Number(process.env.PORT ?? 5273);
const HOST = "127.0.0.1";
/** 想锁版本就设 LMFPD_SPEC=lmfpd@0.0.1792416845676 */
const LMFPD_SPEC = process.env.LMFPD_SPEC ?? "lmfpd@latest";
const TUI_LIMIT = 400_000;

await mkdir(DATA_DIR, { recursive: true });
await mkdir(RUNS_DIR, { recursive: true });

// ---------------------------------------------------------------- 类型

type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  createdAt: number;
  updatedAt: number;
};

type RunOptions = {
  api: "responses" | "chatcompletion" | "message";
  count: number;
  parallel: number;
  repeat: number;
  strict: boolean;
  noStream: boolean;
  timeout: number;
  effort?: string;
  serviceTier?: string;
  tokenizer: boolean;
  maxProbes?: number;
  cols: number;
};

type RunStatus = "queued" | "running" | "done" | "error" | "cancelled";

type RunRecord = {
  id: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  options: RunOptions;
  status: RunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  /** 完整 ANSI 输出，用于历史回放 */
  tui: string;
  hasReport?: boolean;
};

// ---------------------------------------------------------------- 供应商

async function readProviders(): Promise<Provider[]> {
  try {
    const parsed = JSON.parse(await readFile(PROVIDERS_FILE, "utf8"));
    const list: Provider[] = Array.isArray(parsed) ? parsed : [];
    return list.map((p) => ({ ...p, baseUrl: normalizeBaseUrl(p.baseUrl ?? "") }));
  } catch {
    return [];
  }
}

async function writeProviders(list: Provider[]) {
  await writeFile(PROVIDERS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  try {
    await chmod(PROVIDERS_FILE, 0o600);
  } catch {}
}

function maskKey(key: string) {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 2) + "***";
  return key.slice(0, 5) + "…" + key.slice(-4);
}

function publicProvider(p: Provider) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    keyMasked: maskKey(p.apiKey),
    models: p.models ?? [],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ---------------------------------------------------------------- 模型列表

// 收敛成标准格式：去掉尾部斜杠；路径里没有版本段时补 /v1
function normalizeBaseUrl(raw: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s.replace(/\/+$/, "");
  }
  // 注意先算完再赋值：给 pathname 赋空串会被 URL 规范回 "/"，直接 += 会拼出 //v1
  let path = u.pathname.replace(/\/+$/, "");
  // 已有 /v1、/v1beta、/v2 这类版本段就原样保留
  if (!/\/v\d+[a-z0-9]*/i.test(path)) path += "/v1";
  u.pathname = path;
  return u.toString();
}

function modelsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (!u.pathname || u.pathname === "/") return `${u.origin}/v1/models`;
    return `${trimmed}/models`;
  } catch {
    return `${trimmed}/models`;
  }
}

async function fetchProviderModels(p: Provider): Promise<string[]> {
  const url = modelsUrl(p.baseUrl);
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${p.apiKey}`,
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`${res.status} ${res.statusText} — ${url}${body ? ` — ${body}` : ""}`);
  }
  const json: any = await res.json();
  const list: any[] = Array.isArray(json) ? json : (json?.data ?? json?.models ?? []);
  const ids = list
    .map((m: any) => (typeof m === "string" ? m : (m?.id ?? m?.name ?? m?.model)))
    .filter((v: any): v is string => typeof v === "string" && v.length > 0);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- 运行管理

const runs = new Map<string, RunRecord>();
const procs = new Map<string, any>();
const listeners = new Map<string, Set<(payload: string) => void>>();
const queue: string[] = [];
let activeRunId: string | null = null;

function broadcast(runId: string, type: string, data: any = {}) {
  const payload = `data: ${JSON.stringify({ type, runId, ...data })}\n\n`;
  for (const send of listeners.get(runId) ?? []) {
    try {
      send(payload);
    } catch {}
  }
}

async function persistRun(run: RunRecord) {
  await writeFile(join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2));
}

async function loadRun(id: string): Promise<RunRecord | null> {
  if (runs.has(id)) return runs.get(id)!;
  try {
    const rec = JSON.parse(await readFile(join(RUNS_DIR, `${id}.json`), "utf8")) as RunRecord;
    if (rec.status === "running" || rec.status === "queued") {
      rec.status = "error";
      rec.error = rec.error ?? "进程被中断（界面重启过）";
    }
    runs.set(id, rec);
    return rec;
  } catch {
    return null;
  }
}

function buildArgs(run: RunRecord, outputPath: string) {
  const o = run.options;
  const args = [LMFPD_SPEC, "--no-update-check", "--output", outputPath];
  // -b / -k / -m 走环境变量，命令行里不出现 key
  if (o.api && o.api !== "responses") args.push("-a", o.api);
  if (Number.isFinite(o.count)) args.push("--count", String(o.count));
  if (Number.isFinite(o.parallel)) args.push("-p", String(o.parallel));
  if (Number.isFinite(o.repeat) && o.repeat > 1) args.push("-n", String(o.repeat));
  if (o.strict) args.push("--strict");
  if (o.noStream) args.push("-ns");
  if (Number.isFinite(o.timeout) && o.timeout > 0 && o.timeout !== 120) {
    args.push("--timeout", String(o.timeout));
  }
  if (o.effort) args.push("-e", o.effort);
  if (o.serviceTier && o.serviceTier !== "default") args.push("-t", o.serviceTier);
  if (o.tokenizer) {
    args.push("--tokenizer");
    if (Number.isFinite(o.maxProbes!) && o.maxProbes! !== 20) args.push("--max-probes", String(o.maxProbes));
  }
  return args;
}

function bunxPath() {
  const sibling = join(dirname(process.execPath), "bunx");
  return existsSync(sibling) ? sibling : "bunx";
}

function trimTui(text: string) {
  if (text.length <= TUI_LIMIT) return text;
  const cut = text.slice(-TUI_LIMIT);
  const nl = cut.indexOf("\n");
  return nl === -1 ? cut : cut.slice(nl + 1);
}

async function startNextRun() {
  if (activeRunId) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const run = runs.get(nextId);
  if (!run) return startNextRun();

  const provider = (await readProviders()).find((p) => p.id === run.providerId);
  if (!provider) {
    run.status = "error";
    run.error = "供应商已被删除";
    run.finishedAt = Date.now();
    broadcast(run.id, "done", { status: run.status, error: run.error });
    await persistRun(run);
    return startNextRun();
  }

  activeRunId = run.id;
  run.status = "running";
  run.startedAt = Date.now();
  broadcast(run.id, "status", { status: "running", startedAt: run.startedAt });
  await persistRun(run);

  const outputPath = join(RUNS_DIR, `${run.id}.report.json`);
  const args = buildArgs(run, outputPath);

  // 输出分片合并后按 50ms 批量推，避免 SSE 刷爆
  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushTimer = null;
    if (!pending) return;
    const chunk = pending;
    pending = "";
    broadcast(run.id, "tui", { chunk });
  };
  const push = (chunk: string) => {
    run.tui = trimTui(run.tui + chunk);
    pending += chunk;
    if (!flushTimer) flushTimer = setTimeout(flush, 50);
  };

  let proc: any;
  try {
    proc = Bun.spawn([bunxPath(), ...args], {
      env: {
        ...(Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>),
        API_KEY: provider.apiKey,
        BASE_URL: provider.baseUrl,
        MODEL: run.model,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
      },
      terminal: {
        cols: run.options.cols ?? 110,
        rows: 40,
        data(_term: any, chunk: Uint8Array) {
          push(new TextDecoder().decode(chunk));
        },
      },
      stdin: "ignore",
    });
  } catch (err: any) {
    run.status = "error";
    run.error = `无法启动进程：${err?.message ?? err}`;
    run.finishedAt = Date.now();
    activeRunId = null;
    broadcast(run.id, "done", { status: run.status, error: run.error });
    await persistRun(run);
    return startNextRun();
  }

  procs.set(run.id, proc);

  const exitCode = await proc.exited;
  procs.delete(run.id);
  if (flushTimer) clearTimeout(flushTimer);
  flush();

  run.exitCode = exitCode;
  run.finishedAt = Date.now();

  try {
    run.hasReport = (await stat(outputPath)).size > 0;
  } catch {
    run.hasReport = false;
  }

  if (exitCode === 0) run.status = "done";
  else if (exitCode === 130 || exitCode === 143) run.status = "cancelled";
  else run.status = "error";

  if (run.status === "error" && !run.tui.trim()) {
    run.error = `进程无输出，退出码 ${exitCode}（检查 base url / key / 网络）`;
  }

  // 记住测过的模型
  const providers = await readProviders();
  const hit = providers.find((p) => p.id === run.providerId);
  if (hit && !hit.models.includes(run.model)) {
    hit.models.push(run.model);
    hit.updatedAt = Date.now();
    await writeProviders(providers);
  }

  activeRunId = null;
  broadcast(run.id, "done", {
    status: run.status,
    exitCode,
    error: run.error ?? null,
    hasReport: run.hasReport,
    finishedAt: run.finishedAt,
  });
  await persistRun(run);
  startNextRun();
}

// ---------------------------------------------------------------- HTTP

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function checkLocal(req: Request) {
  const host = (req.headers.get("host") ?? "").split(":")[0].replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const u = new URL(origin);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = join(PUBLIC_DIR, rel.replace(/\.\./g, ""));
  try {
    const data = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(data, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function sanitizeOptions(input: any): RunOptions {
  const clampInt = (v: any, min: number, max: number, fallback: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  const api = ["responses", "chatcompletion", "message"].includes(input?.api) ? input.api : "responses";
  return {
    api,
    count: clampInt(input?.count, 1, 3, 3),
    parallel: clampInt(input?.parallel, 1, 3, 3),
    repeat: clampInt(input?.repeat, 1, 20, 1),
    strict: Boolean(input?.strict),
    noStream: Boolean(input?.noStream),
    timeout: clampInt(input?.timeout, 5, 1800, 120),
    effort: typeof input?.effort === "string" && input.effort.trim() ? input.effort.trim() : undefined,
    serviceTier:
      typeof input?.serviceTier === "string" && input.serviceTier.trim() && input.serviceTier !== "default"
        ? input.serviceTier.trim()
        : undefined,
    tokenizer: Boolean(input?.tokenizer),
    maxProbes: clampInt(input?.maxProbes, 4, 60, 20),
    cols: clampInt(input?.cols, 70, 200, 110),
  };
}

function summaryOf(run: RunRecord) {
  return {
    id: run.id,
    providerId: run.providerId,
    providerName: run.providerName,
    model: run.model,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    exitCode: run.exitCode ?? null,
    error: run.error ?? null,
    hasReport: run.hasReport ?? false,
  };
}

function fullRun(run: RunRecord) {
  return {
    ...summaryOf(run),
    options: run.options,
    baseUrl: run.baseUrl,
    tui: run.tui,
    log: run.tui, // 兼容旧字段名
    report: null,
  };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (!checkLocal(req)) return json({ error: "只允许本机访问" }, 403);
      try {
        return await route(req, url);
      } catch (err: any) {
        return json({ error: err?.message ?? String(err) }, 500);
      }
    }
    return serveStatic(url.pathname);
  },
});

async function route(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/api/state" && method === "GET") {
    const providers = await readProviders();
    const files = await readdir(RUNS_DIR).catch(() => [] as string[]);
    const summaries: any[] = [];
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".report.json")) continue;
      const rec = await loadRun(f.replace(/\.json$/, ""));
      if (rec) summaries.push(summaryOf(rec));
    }
    summaries.sort((a, b) => b.createdAt - a.createdAt);
    return json({
      providers: providers.map(publicProvider),
      runs: summaries.slice(0, 60),
      activeRunId,
      spec: LMFPD_SPEC,
    });
  }

  if (pathname === "/api/providers" && method === "POST") {
    const body: any = await req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();
    const baseUrl = String(body.baseUrl ?? "").trim();
    const apiKey = String(body.apiKey ?? "").trim();
    if (!baseUrl) return json({ error: "base url 必填" }, 400);
    if (!apiKey) return json({ error: "api key 必填" }, 400);
    if (!/^https?:\/\//i.test(baseUrl)) return json({ error: "base url 需以 http(s):// 开头" }, 400);
    const list = await readProviders();
    const provider: Provider = {
      id: randomUUID(),
      name: name || new URL(baseUrl).host,
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey,
      models: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    list.push(provider);
    await writeProviders(list);
    return json({ provider: publicProvider(provider) });
  }

  const providerMatch = pathname.match(/^\/api\/providers\/([\w-]+)$/);
  if (providerMatch) {
    const list = await readProviders();
    const idx = list.findIndex((p) => p.id === providerMatch[1]);
    if (idx === -1) return json({ error: "供应商不存在" }, 404);

    if (method === "PATCH") {
      const body: any = await req.json().catch(() => ({}));
      const p = list[idx];
      if (typeof body.name === "string" && body.name.trim()) p.name = body.name.trim();
      if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
        if (!/^https?:\/\//i.test(body.baseUrl.trim())) return json({ error: "base url 格式不对" }, 400);
        p.baseUrl = normalizeBaseUrl(body.baseUrl);
      }
      if (typeof body.apiKey === "string" && body.apiKey.trim()) p.apiKey = body.apiKey.trim();
      p.updatedAt = Date.now();
      await writeProviders(list);
      return json({ provider: publicProvider(p) });
    }

    if (method === "DELETE") {
      const [removed] = list.splice(idx, 1);
      await writeProviders(list);
      return json({ ok: true, id: removed.id });
    }
  }

  const modelsMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models$/);
  if (modelsMatch && (method === "POST" || method === "GET")) {
    const list = await readProviders();
    const p = list.find((x) => x.id === modelsMatch[1]);
    if (!p) return json({ error: "供应商不存在" }, 404);
    if (method === "GET") return json({ models: p.models ?? [] });
    try {
      const fetched = await fetchProviderModels(p);
      p.models = [...new Set([...fetched, ...(p.models ?? [])])].sort((a, b) => a.localeCompare(b));
      p.updatedAt = Date.now();
      await writeProviders(list);
      return json({ models: p.models, fetched: fetched.length });
    } catch (err: any) {
      return json({ error: `拉取模型失败：${err?.message ?? err}`, models: p.models ?? [] }, 502);
    }
  }

  if (pathname === "/api/runs" && method === "POST") {
    const body: any = await req.json().catch(() => ({}));
    const list = await readProviders();
    const provider = list.find((p) => p.id === body.providerId);
    if (!provider) return json({ error: "先选一个供应商" }, 400);
    const model = String(body.model ?? "").trim();
    if (!model) return json({ error: "模型名必填" }, 400);

    const run: RunRecord = {
      id: randomUUID().slice(0, 8) + "-" + Date.now().toString(36),
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      model,
      options: sanitizeOptions(body.options),
      status: "queued",
      createdAt: Date.now(),
      tui: "",
    };
    if (run.options.strict) run.options.count = 3;
    runs.set(run.id, run);
    queue.push(run.id);
    await persistRun(run);
    startNextRun();
    return json({ runId: run.id, summary: summaryOf(run) });
  }

  const runMatch = pathname.match(/^\/api\/runs\/([\w-]+)$/);
  if (runMatch) {
    const run = await loadRun(runMatch[1]);
    if (!run) return json({ error: "运行不存在" }, 404);
    if (method === "DELETE") {
      const proc = procs.get(run.id);
      if (proc) proc.kill("SIGTERM");
      const q = queue.indexOf(run.id);
      if (q !== -1) queue.splice(q, 1);
      await persistRun(run);
      try {
        await rm(join(RUNS_DIR, `${run.id}.json`));
        await rm(join(RUNS_DIR, `${run.id}.report.json`));
      } catch {}
      runs.delete(run.id);
      return json({ ok: true });
    }
    return json({ run: fullRun(run) });
  }

  const cancelMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    const run = await loadRun(cancelMatch[1]);
    if (!run) return json({ error: "运行不存在" }, 404);
    const proc = procs.get(run.id);
    if (proc) proc.kill("SIGTERM");
    if (run.status === "queued") {
      const q = queue.indexOf(run.id);
      if (q !== -1) queue.splice(q, 1);
      run.status = "cancelled";
      run.finishedAt = Date.now();
      await persistRun(run);
      broadcast(run.id, "done", { status: "cancelled" });
    }
    return json({ ok: true });
  }

  // 原始报告（不解析，原样返回，仅供留档查看）
  const reportMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/report$/);
  if (reportMatch && method === "GET") {
    try {
      const text = await readFile(join(RUNS_DIR, `${reportMatch[1]}.report.json`), "utf8");
      return new Response(text, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    } catch {
      return json({ error: "这次运行没有保存报告" }, 404);
    }
  }

  const streamMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/stream$/);
  if (streamMatch && method === "GET") {
    const run = await loadRun(streamMatch[1]);
    if (!run) return json({ error: "运行不存在" }, 404);
    const runId = run.id;
    let send: ((p: string) => void) | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        send = (payload: string) => controller.enqueue(enc.encode(payload));
        if (!listeners.has(runId)) listeners.set(runId, new Set());
        listeners.get(runId)!.add(send);
        send(
          `data: ${JSON.stringify({
            type: "snapshot",
            runId,
            status: run.status,
            tui: run.tui,
            exitCode: run.exitCode ?? null,
            error: run.error ?? null,
            hasReport: run.hasReport ?? false,
            startedAt: run.startedAt ?? null,
            finishedAt: run.finishedAt ?? null,
          })}\n\n`,
        );
      },
      cancel() {
        if (send) listeners.get(runId)?.delete(send);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }

  return json({ error: "未知接口" }, 404);
}

console.log(`
  fpd-web  →  http://${HOST}:${PORT}
  供应商:   ${PROVIDERS_FILE} (chmod 600)
  运行记录: ${RUNS_DIR}
  检测包:   ${LMFPD_SPEC}
  模式:     PTY 实时终端（不解析 JSON）
`);
