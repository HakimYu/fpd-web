/* fpd-web 前端 —— 零依赖。核心是那台小终端：吃 lmfpd 的 ANSI 输出，回放成带高亮的画面。 */

const $ = (id) => document.getElementById(id);

const LS = {
  get(k, def) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const S = {
  providers: [],
  runs: [],
  spec: "lmfpd@latest",
  selectedId: LS.get("fpd.provider", null),
  editingId: null,
  run: null,
  es: null,
  term: null,
  stick: true,
  raf: 0,
  timer: null,
  loadedRunId: null,
};

/* ================================================================ 小终端 */

const SGR_COLORS = {
  30: 30, 31: 31, 32: 32, 33: 33, 34: 34, 35: 35, 36: 36, 37: 37,
  90: 90, 91: 91, 92: 92, 93: 93, 94: 94, 95: 95, 96: 96, 97: 97,
};

class Term {
  constructor(cols = 110) {
    this.cols = cols;
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
    this.fg = null;
    this.bg = null;
    this.flags = new Set();
    this.hold = "";
  }

  get cls() {
    const out = [];
    if (this.fg != null) out.push(`t-fg-${this.fg}`);
    if (this.bg != null) out.push(`t-bg-${this.bg}`);
    for (const f of this.flags) out.push(`t-${f}`);
    return out.join(" ");
  }

  lineAt(r) {
    while (this.lines.length <= r) this.lines.push([]);
    return this.lines[r];
  }

  putChar(ch) {
    const line = this.lineAt(this.row);
    while (line.length < this.col) line.push({ ch: " ", cls: "" });
    line[this.col] = { ch, cls: this.cls };
    this.col++;
  }

  csi(paramStr, final) {
    const params = paramStr.split(";").filter((s) => s !== "");
    const n = (i, def = 1) => {
      const v = parseInt(params[i] ?? "", 10);
      return Number.isFinite(v) ? v : def;
    };

    if (paramStr.startsWith("?")) return; // 私有模式(?25l/h、?2026h/l)一律忽略

    switch (final) {
      case "A": this.row = Math.max(0, this.row - n(0)); break;
      case "B": this.row = this.row + n(0); this.lineAt(this.row); break;
      case "C": this.col += n(0); break;
      case "D": this.col = Math.max(0, this.col - n(0)); break;
      case "E": this.row += n(0); this.col = 0; this.lineAt(this.row); break;
      case "F": this.row = Math.max(0, this.row - n(0)); this.col = 0; break;
      case "G": this.col = Math.max(0, n(0) - 1); break;
      case "H":
      case "f":
        this.row = Math.max(0, n(0) - 1);
        this.col = Math.max(0, n(1) - 1);
        this.lineAt(this.row);
        break;
      case "K": {
        const mode = params[0] ?? "0";
        const line = this.lineAt(this.row);
        if (mode === "2") line.length = 0;
        else if (mode === "1") for (let i = 0; i <= this.col && i < line.length; i++) line[i] = { ch: " ", cls: "" };
        else line.length = Math.min(line.length, this.col);
        break;
      }
      case "J": {
        const mode = params[0] ?? "0";
        if (mode === "2" || mode === "3") {
          this.lines = [[]];
          this.row = 0;
          this.col = 0;
        } else {
          const line = this.lineAt(this.row);
          line.length = Math.min(line.length, this.col);
          this.lines.length = this.row + 1;
        }
        break;
      }
      case "m": this.sgr(params); break;
      default: break;
    }
  }

  sgr(params) {
    if (!params.length) params = ["0"];
    for (let i = 0; i < params.length; i++) {
      const code = parseInt(params[i], 10);
      if (!Number.isFinite(code)) continue;
      if (code === 0) {
        this.fg = null; this.bg = null; this.flags.clear();
      } else if (code === 1 || code === 2 || code === 3 || code === 4 || code === 7 || code === 9) {
        this.flags.add({ 1: "bold", 2: "dim", 3: "italic", 4: "underline", 7: "inverse", 9: "strike" }[code]);
      } else if (code === 22) {
        this.flags.delete("bold"); this.flags.delete("dim");
      } else if (code === 23) this.flags.delete("italic");
      else if (code === 24) this.flags.delete("underline");
      else if (code === 27) this.flags.delete("inverse");
      else if (code === 29) this.flags.delete("strike");
      else if (SGR_COLORS[code] !== undefined) this.fg = code;
      else if (code === 39) this.fg = null;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.bg = code;
      else if (code === 49) this.bg = null;
      else if (code === 38 || code === 48) {
        // 256 色 / truecolor：吃掉后续参数，退化成默认色
        if (params[i + 1] === "5") i += 2;
        else if (params[i + 1] === "2") i += 4;
      }
    }
  }

  write(chunk) {
    if (!chunk) return;
    const data = this.hold + chunk;
    this.hold = "";
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1b") {
        const next = data[i + 1];
        if (next === "]") {
          // OSC（含超链接）：跳到 BEL 或 ESC \
          const bel = data.indexOf("\x07", i);
          const st = data.indexOf("\x1b\\", i);
          let end = -1;
          if (bel !== -1 && (st === -1 || bel < st)) end = bel + 1;
          else if (st !== -1) end = st + 2;
          if (end === -1) {
            this.hold = data.slice(i);
            return;
          }
          i = end;
          continue;
        }
        if (next === "[") {
          const m = /^\x1b\[([0-9;?<>=]*)([ -/]*)([@-~])/.exec(data.slice(i));
          if (!m) {
            if (data.length - i < 32) {
              this.hold = data.slice(i);
              return;
            }
            i += 2;
            continue;
          }
          this.csi(m[1], m[3]);
          i += m[0].length;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === "\n") {
        this.row++;
        this.col = 0;
        this.lineAt(this.row);
      } else if (ch === "\r") {
        this.col = 0;
      } else if (ch === "\b") {
        this.col = Math.max(0, this.col - 1);
      } else if (ch === "\t") {
        this.col += 8 - (this.col % 8);
      } else if (ch >= " ") {
        this.putChar(ch);
      }
      i++;
    }
    this.compact();
  }

  compact() {
    const MAX = 600;
    if (this.lines.length > MAX) {
      const drop = this.lines.length - MAX;
      this.lines.splice(0, drop);
      this.row = Math.max(0, this.row - drop);
    }
  }

  reset() {
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
    this.fg = null;
    this.bg = null;
    this.flags.clear();
    this.hold = "";
  }
}

function paint(host, term) {
  if (!host || !term) return;
  const frag = document.createDocumentFragment();
  const lines = term.lines;

  let last = lines.length - 1;
  while (last > 0 && !lines[last].some((c) => c && c.ch !== " ")) last--;

  for (let r = 0; r <= last; r++) {
    const line = lines[r] ?? [];
    let end = line.length;
    while (end > 0 && (!line[end - 1] || line[end - 1].ch === " ")) end--;

    const div = document.createElement("div");
    div.className = "tline";
    let i = 0;
    while (i < end) {
      const cell = line[i] ?? { ch: " ", cls: "" };
      let j = i;
      let text = "";
      const cls = cell.cls ?? "";
      while (j < end && (line[j]?.cls ?? "") === cls) {
        text += line[j]?.ch ?? " ";
        j++;
      }
      const span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = text;
      div.append(span);
      i = j;
    }
    frag.append(div);
  }
  host.replaceChildren(frag);

  const box = host.parentElement;
  if (box && S.stick) box.scrollTop = box.scrollHeight;
}

function schedulePaint() {
  if (S.raf) return;
  S.raf = requestAnimationFrame(() => {
    S.raf = 0;
    paint($("term-body"), S.term);
  });
  const el = $("term-elapsed");
  if (el) el.textContent = elapsedText(S.run);
}

/* ================================================================ 工具 */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const fmtTime = (ts) =>
  ts
    ? new Date(ts).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

const fmtDur = (ms) => {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

function toast(msg, kind = "info") {
  const t = el("div", { class: `toast toast-${kind}`, text: msg });
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url || "";
  }
}

/* ================================================================ 状态 */

async function refresh() {
  const st = await api("/api/state");
  S.providers = st.providers;
  S.runs = st.runs;
  S.spec = st.spec || "lmfpd@latest";
  $("spec").textContent = S.spec;
  $("health").className = "dot up";

  if (!S.providers.find((p) => p.id === S.selectedId)) S.selectedId = S.providers[0]?.id ?? null;

  renderProviders();
  renderModelArea();
  renderHistory();
  updatePanelState();

  if (st.activeRunId && !S.run) attachRun(st.activeRunId);
}

/* ================================================================ 供应商 */

function currentProvider() {
  return S.providers.find((p) => p.id === S.selectedId) ?? null;
}

function renderProviders() {
  const list = $("provider-list");
  list.replaceChildren();
  $("provider-empty").hidden = S.providers.length > 0;

  for (const p of S.providers) {
    list.append(
      el(
        "li",
        {
          class: `provider-item${p.id === S.selectedId ? " active" : ""}`,
          onclick: (e) => {
            if (e.target.closest(".icon-btn")) return;
            S.selectedId = p.id;
            LS.set("fpd.provider", p.id);
            renderProviders();
            renderModelArea();
            updatePanelState();
          },
        },
        el(
          "div",
          { class: "pv-top" },
          el("span", { class: "pv-name", text: p.name }),
          el(
            "div",
            { class: "pv-actions" },
            el("button", { class: "icon-btn", title: "编辑", text: "✎", onclick: () => openDialog(p) }),
            el("button", {
              class: "icon-btn",
              title: "删除",
              text: "✕",
              onclick: async () => {
                if (!confirm(`删除供应商「${p.name}」？历史记录会保留。`)) return;
                await api(`/api/providers/${p.id}`, { method: "DELETE" });
                if (S.selectedId === p.id) S.selectedId = null;
                await refresh();
              },
            }),
          ),
        ),
        el("div", { class: "pv-host", text: hostOf(p.baseUrl) }),
        el("div", {
          class: "pv-key",
          text: `${p.keyMasked}${p.models.length ? ` · ${p.models.length} 个模型` : ""}`,
        }),
      ),
    );
  }
}

function openDialog(provider = null) {
  S.editingId = provider?.id ?? null;
  $("dialog-title").textContent = provider ? "编辑供应商" : "新增供应商";
  $("pv-name").value = provider?.name ?? "";
  $("pv-baseurl").value = provider?.baseUrl ?? "";
  $("pv-apikey").value = "";
  $("pv-apikey").placeholder = provider ? "留空则不修改" : "sk-...";
  $("pv-keyhint").textContent = provider ? `当前：${provider.keyMasked}` : "";
  $("provider-dialog").showModal();
  setTimeout(() => $("pv-baseurl").focus(), 30);
}

async function saveProvider() {
  const payload = {
    name: $("pv-name").value.trim(),
    baseUrl: $("pv-baseurl").value.trim(),
    apiKey: $("pv-apikey").value.trim(),
  };
  try {
    if (S.editingId) {
      if (!payload.apiKey) delete payload.apiKey;
      await api(`/api/providers/${S.editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      const { provider } = await api("/api/providers", { method: "POST", body: JSON.stringify(payload) });
      S.selectedId = provider.id;
      LS.set("fpd.provider", provider.id);
    }
    $("provider-dialog").close();
    await refresh();
    toast("已保存", "good");
  } catch (err) {
    toast(err.message, "bad");
  }
}

/* ================================================================ 模型 */

function recentModels() {
  return LS.get("fpd.models", []);
}

function pushRecentModel(model) {
  if (!model) return;
  LS.set("fpd.models", [model, ...recentModels().filter((m) => m !== model)].slice(0, 12));
}

function renderModelArea() {
  const p = currentProvider();
  const models = [...new Set([...(p?.models ?? []), ...recentModels()])];
  const dl = $("model-list");
  dl.replaceChildren();
  for (const m of models) dl.append(el("option", { value: m }));

  const chips = $("model-chips");
  chips.replaceChildren();
  const recent = recentModels().slice(0, 6);
  for (const m of recent) {
    chips.append(el("button", { class: "chip", text: m, onclick: () => { $("model").value = m; updateCmd(); } }));
  }
  if (!recent.length) chips.append(el("span", { class: "hint-inline", text: "点「拉取模型」从 /models 取列表" }));
}

function updatePanelState() {
  const p = currentProvider();
  $("panel-provider").textContent = p ? `${p.name} · ${hostOf(p.baseUrl)}` : "未选择供应商";
  const busy = S.run && ["queued", "running"].includes(S.run.status);
  $("run-btn").disabled = !p || busy;
  updateCmd();
}

/* ================================================================ 选项 */

function collectOptions() {
  return {
    api: $("opt-api").value,
    count: Number($("opt-count").value),
    parallel: Number($("opt-parallel").value),
    repeat: Number($("opt-repeat").value) || 1,
    strict: $("opt-strict").checked,
    noStream: $("opt-nostream").checked,
    timeout: Number($("opt-timeout").value) || 120,
    effort: $("opt-effort").value.trim(),
    serviceTier: $("opt-tier").value,
    tokenizer: $("opt-tokenizer").checked,
    maxProbes: Number($("opt-maxprobes").value) || 20,
    cols: Number($("opt-cols").value) || 110,
  };
}

function saveOptions() {
  LS.set("fpd.options", collectOptions());
}

function restoreOptions() {
  const o = LS.get("fpd.options", null);
  if (!o) return;
  if (o.api) $("opt-api").value = o.api;
  if (o.count) $("opt-count").value = String(o.count);
  if (o.parallel) $("opt-parallel").value = String(o.parallel);
  if (o.repeat) $("opt-repeat").value = o.repeat;
  if (o.timeout) $("opt-timeout").value = o.timeout;
  if (o.effort) $("opt-effort").value = o.effort;
  if (o.serviceTier) $("opt-tier").value = o.serviceTier;
  if (o.cols) $("opt-cols").value = String(o.cols);
  $("opt-strict").checked = !!o.strict;
  $("opt-nostream").checked = !!o.noStream;
  $("opt-tokenizer").checked = !!o.tokenizer;
  if (o.maxProbes) $("opt-maxprobes").value = o.maxProbes;
}

function commandString() {
  const p = currentProvider();
  const model = $("model").value.trim() || "<model>";
  const o = collectOptions();
  const parts = ["bunx lmfpd@latest"];
  parts.push(`-b ${p ? p.baseUrl : "<base-url>"}`);
  parts.push("-k sk-xxx");
  parts.push(`-m ${model}`);
  if (o.api !== "responses") parts.push(`-a ${o.api}`);
  if (o.count !== 3) parts.push(`--count ${o.count}`);
  if (o.parallel !== 3) parts.push(`-p ${o.parallel}`);
  if (o.repeat > 1) parts.push(`-n ${o.repeat}`);
  if (o.strict) parts.push("--strict");
  if (o.noStream) parts.push("-ns");
  if (o.timeout !== 120) parts.push(`--timeout ${o.timeout}`);
  if (o.effort) parts.push(`-e ${o.effort}`);
  if (o.serviceTier !== "default") parts.push(`-t ${o.serviceTier}`);
  if (o.tokenizer) {
    parts.push("--tokenizer");
    if (o.maxProbes !== 20) parts.push(`--max-probes ${o.maxProbes}`);
  }
  return parts.join(" \\\n  ");
}

function updateCmd() {
  $("cmdline").textContent = commandString();
}

/* ================================================================ 起跑 */

async function startRun() {
  const p = currentProvider();
  if (!p) return toast("先选供应商", "bad");
  const model = $("model").value.trim();
  if (!model) return toast("填模型名", "bad");

  saveOptions();
  pushRecentModel(model);
  renderModelArea();

  try {
    const { runId } = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ providerId: p.id, model, options: collectOptions() }),
    });
    attachRun(runId);
  } catch (err) {
    toast(err.message, "bad");
  }
}

async function attachRun(runId) {
  stopStream();
  const { run } = await api(`/api/runs/${runId}`);
  S.run = run;
  S.loadedRunId = run.id;
  S.stick = true;
  S.term = new Term(run.options?.cols ?? 110);
  S.term.write(run.tui ?? "");
  renderRunCard();
  updatePanelState();
  if (["queued", "running"].includes(run.status)) openStream(runId);
}

function stopStream() {
  if (S.es) {
    S.es.close();
    S.es = null;
  }
  if (S.timer) {
    clearInterval(S.timer);
    S.timer = null;
  }
}

function openStream(runId) {
  const es = new EventSource(`/api/runs/${runId}/stream`);
  S.es = es;

  es.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "snapshot") {
      if (S.loadedRunId !== runId) return;
      S.run = {
        ...(S.run ?? {}),
        status: msg.status,
        exitCode: msg.exitCode,
        error: msg.error,
        hasReport: msg.hasReport,
        startedAt: msg.startedAt,
        finishedAt: msg.finishedAt,
      };
      if (msg.tui && (!S.term || S.term.lines.length <= 1)) {
        S.term = new Term(S.run.options?.cols ?? 110);
        S.term.write(msg.tui);
      }
      renderRunHeader();
      schedulePaint();
      if (!["queued", "running"].includes(msg.status)) finishRun();
    } else if (msg.type === "tui") {
      if (S.loadedRunId !== runId || !S.term) return;
      S.term.write(msg.chunk);
      schedulePaint();
    } else if (msg.type === "status") {
      if (S.run) S.run.status = msg.status;
      if (msg.startedAt && S.run) S.run.startedAt = msg.startedAt;
      renderRunHeader();
      startTicker();
    } else if (msg.type === "done") {
      if (!S.run) return;
      S.run.status = msg.status;
      S.run.exitCode = msg.exitCode;
      S.run.error = msg.error;
      S.run.hasReport = msg.hasReport;
      S.run.finishedAt = msg.finishedAt ?? Date.now();
      finishRun();
    }
  };

  es.onerror = () => {
    if (!S.run || ["done", "error", "cancelled"].includes(S.run.status)) {
      stopStream();
      return;
    }
    setTimeout(async () => {
      try {
        const { run } = await api(`/api/runs/${runId}`);
        if (!["queued", "running"].includes(run.status)) {
          S.run = run;
          finishRun();
        }
      } catch {}
    }, 1500);
  };

  startTicker();
}

function finishRun() {
  stopStream();
  if (S.es) {
    S.es.close();
    S.es = null;
  }
  renderRunCard();
  updatePanelState();
  refresh().catch(() => {});
}

function startTicker() {
  if (S.timer) return;
  S.timer = setInterval(() => {
    const e = $("term-elapsed");
    if (e) e.textContent = elapsedText(S.run);
  }, 1000);
}

function elapsedText(run) {
  if (!run) return "—";
  const start = run.startedAt ?? run.createdAt;
  if (!start) return "—";
  const end = run.finishedAt ?? Date.now();
  return fmtDur(end - start);
}

/* ================================================================ 结果卡片 */

function renderRunCard() {
  const section = $("result-section");
  const run = S.run;
  if (!run) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const card = $("result-card");
  card.replaceChildren();
  card.append(el("div", { id: "run-head" }));
  card.append(
    el(
      "div",
      { class: "cmd-echo", title: "这条命令由服务端执行，key 通过环境变量注入" },
      el("span", { class: "prompt", text: "$ " }),
      el("span", { text: commandForRun(run) }),
    ),
  );

  const body = el("pre", { class: "term-body", id: "term-body" });
  const box = el(
    "div",
    { class: "term-box" },
    el(
      "div",
      { class: "term-bar" },
      el("span", { class: "dots" }, el("i", {}), el("i", {}), el("i", {})),
      el("span", { class: "term-title", text: `fpd · ${run.options?.cols ?? 110} cols` }),
      el("span", { class: "term-hint", text: "PTY 实时输出 · ANSI 高亮" }),
    ),
    body,
  );
  card.append(box);

  card.append(
    el(
      "div",
      { class: "run-actions", id: "run-actions" },
      el("button", { class: "btn btn-ghost btn-sm", id: "rerun-btn", text: "再测一次", onclick: rerun }),
      el("button", {
        class: "btn btn-ghost btn-sm",
        text: "查看原始报告 JSON",
        id: "report-btn",
        onclick: () => showReport(run.id),
      }),
      el("button", { class: "btn btn-ghost btn-sm", text: "复制命令", onclick: copyRunCommand }),
    ),
  );

  body.parentElement.addEventListener("scroll", () => {
    const b = body.parentElement;
    S.stick = b.scrollHeight - b.scrollTop - b.clientHeight < 48;
  });

  renderRunHeader();
  paint(body, S.term);
  startTicker();
}

function renderRunHeader() {
  const host = $("run-head");
  if (!host) return;
  const run = S.run;
  const running = ["queued", "running"].includes(run.status);
  const pillCls =
    run.status === "done" ? "pill-good" : run.status === "error" ? "pill-bad" : run.status === "cancelled" ? "pill-warn" : "pill-muted";
  const label = { queued: "排队中", running: "检测中", done: "已完成", error: "失败", cancelled: "已取消" }[run.status] ?? run.status;

  host.replaceChildren(
    running ? el("div", { class: "spinner" }) : el("div", { class: `status-dot ${pillCls}` }),
    el("h2", { text: "检测输出" }),
    el("span", { class: `pill ${pillCls}`, text: label }),
    el("span", { class: "pill", text: run.model }),
    el("span", { class: "pill pill-muted", text: `${run.providerName} · ${hostOf(run.baseUrl)}` }),
    el("span", { class: "pill pill-muted", id: "term-elapsed", text: `用时 ${elapsedText(run)}` }),
    run.exitCode != null ? el("span", { class: "pill pill-muted", text: `exit ${run.exitCode}` }) : null,
    running
      ? el("button", {
          class: "btn btn-danger btn-sm",
          text: "取消",
          style: "margin-left:auto",
          onclick: async () => {
            await api(`/api/runs/${run.id}/cancel`, { method: "POST" });
            toast("已发送 SIGTERM", "warn");
          },
        })
      : el("span", { style: "margin-left:auto" }),
  );

  const reportBtn = $("report-btn");
  if (reportBtn) {
    reportBtn.disabled = !run.hasReport;
    reportBtn.title = run.hasReport ? "打开这次运行的原始报告（不解析，原样查看）" : "这次没有保存报告";
  }
}

function commandForRun(run) {
  const o = run.options ?? {};
  const parts = ["bunx lmfpd@latest", `-b ${run.baseUrl}`, "-k ••••••", `-m ${run.model}`];
  if (o.api && o.api !== "responses") parts.push(`-a ${o.api}`);
  if (o.count != null) parts.push(`--count ${o.count}`);
  if (o.parallel != null) parts.push(`-p ${o.parallel}`);
  if (o.repeat > 1) parts.push(`-n ${o.repeat}`);
  if (o.strict) parts.push("--strict");
  if (o.noStream) parts.push("-ns");
  if (o.tokenizer) parts.push("--tokenizer");
  return parts.join(" ");
}

async function rerun() {
  if (!S.run) return;
  const p = S.providers.find((x) => x.id === S.run.providerId);
  if (!p) return toast("供应商已被删除", "bad");
  $("model").value = S.run.model;
  S.selectedId = p.id;
  renderProviders();
  renderModelArea();
  startRun();
}

async function copyRunCommand() {
  if (!S.run) return;
  try {
    await navigator.clipboard.writeText(commandForRun(S.run).replace("-k ••••••", "-k sk-xxx"));
    toast("命令已复制", "good");
  } catch {
    toast("复制失败", "bad");
  }
}

async function showReport(runId) {
  const res = await fetch(`/api/runs/${runId}/report`);
  if (!res.ok) return toast("这次运行没有保存报告", "warn");
  const text = await res.text();
  const dlg = el(
    "dialog",
    { class: "report-dialog" },
    el(
      "div",
      { class: "dialog-body" },
      el(
        "div",
        { class: "card-head" },
        el("h2", { text: "原始报告 JSON" }),
        el("button", { class: "btn btn-ghost btn-sm", text: "关闭", onclick: () => dlg.close() }),
      ),
      el("pre", { class: "raw-json", text }),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

/* ================================================================ 历史 */

function renderHistory() {
  const box = $("history");
  box.replaceChildren();
  $("history-count").textContent = String(S.runs.length);
  if (!S.runs.length) {
    box.append(el("div", { class: "empty", text: "还没有运行记录。跑一次检测就会出现在这里。" }));
    return;
  }
  for (const r of S.runs) {
    const pillCls =
      r.status === "done" ? "pill-good" : r.status === "error" ? "pill-bad" : r.status === "cancelled" ? "pill-warn" : "pill-muted";
    box.append(
      el(
        "div",
        {
          class: `history-row${r.id === S.run?.id ? " active" : ""}`,
          onclick: () => {
            history.replaceState(null, "", `?run=${r.id}`);
            attachRun(r.id);
            window.scrollTo({ top: 0, behavior: "smooth" });
          },
        },
        el(
          "div",
          {},
          el("div", { class: "history-model", text: r.model }),
          el("div", { class: "history-sub", text: `${r.providerName} · ${fmtTime(r.createdAt)}` }),
        ),
        el("span", { class: "history-sub", text: r.exitCode != null ? `exit ${r.exitCode}` : "—" }),
        el("span", { class: `pill ${pillCls}`, text: r.status }),
        el("span", { class: "history-sub", text: fmtTime(r.finishedAt) }),
      ),
    );
  }
}

/* ================================================================ 事件 */

function bind() {
  $("add-provider").addEventListener("click", () => openDialog(null));
  $("pv-cancel").addEventListener("click", () => $("provider-dialog").close());
  $("provider-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveProvider();
  });

  $("model").addEventListener("input", updateCmd);
  $("model").addEventListener("change", () => LS.set("fpd.model", $("model").value));
  $("run-btn").addEventListener("click", startRun);

  $("copy-cmd").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(commandString().replace(/ \\\n\s+/g, " "));
      toast("命令已复制（key 用 sk-xxx 占位）", "good");
    } catch {
      toast("复制失败", "bad");
    }
  });

  $("fetch-models").addEventListener("click", async () => {
    const p = currentProvider();
    if (!p) return toast("先选供应商", "bad");
    const btn = $("fetch-models");
    btn.disabled = true;
    btn.textContent = "拉取中…";
    try {
      const { models, fetched } = await api(`/api/providers/${p.id}/models`, { method: "POST" });
      await refresh();
      toast(fetched ? `拉到 ${fetched} 个模型` : "接口没返回模型列表", fetched ? "good" : "warn");
      if (models.length === 1) $("model").value = models[0];
      updateCmd();
    } catch (err) {
      toast(err.message, "bad");
    } finally {
      btn.disabled = false;
      btn.textContent = "拉取模型";
    }
  });

  for (const id of [
    "opt-api",
    "opt-count",
    "opt-parallel",
    "opt-repeat",
    "opt-timeout",
    "opt-effort",
    "opt-tier",
    "opt-strict",
    "opt-nostream",
    "opt-tokenizer",
    "opt-maxprobes",
    "opt-cols",
  ]) {
    $(id).addEventListener("change", () => {
      saveOptions();
      updateCmd();
    });
  }

  $("opt-strict").addEventListener("change", () => {
    if ($("opt-strict").checked && $("opt-count").value !== "3") {
      $("opt-count").value = "3";
      toast("strict 模式已强制 count=3", "warn");
      saveOptions();
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") startRun();
  });
}

/* ================================================================ 启动 */

(async function boot() {
  bind();
  restoreOptions();
  $("model").value = LS.get("fpd.model", "");
  updateCmd();

  try {
    await refresh();
  } catch (err) {
    $("health").className = "dot down";
    toast(`连不上本地服务：${err.message}`, "bad");
  }

  const deepRun = new URLSearchParams(location.search).get("run");
  if (deepRun) {
    try {
      await attachRun(deepRun);
      const p = S.providers.find((x) => x.id === S.run?.providerId);
      if (p) {
        S.selectedId = p.id;
        renderProviders();
        renderModelArea();
      }
      if (!$("model").value && S.run) {
        $("model").value = S.run.model;
        updateCmd();
      }
    } catch {}
  }

  setInterval(() => {
    if (!S.es && !S.run) refresh().catch(() => {});
  }, 15000);
})();
