/* 模型指纹检测 —— 前端。零依赖，核心是那台小终端：吃 lmfpd 的 ANSI 输出，回放成带高亮的画面。 */

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

const STATUS_TEXT = {
  queued: "排队中",
  running: "检测中",
  done: "已完成",
  error: "失败",
  cancelled: "已取消",
};

/* ================================================================ 终端 */

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

    if (paramStr.startsWith("?")) return; // 私有模式（?25l/h、?2026h/l）一律忽略

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
        this.fg = null;
        this.bg = null;
        this.flags.clear();
      } else if (code === 1 || code === 2 || code === 3 || code === 4 || code === 7 || code === 9) {
        this.flags.add({ 1: "bold", 2: "dim", 3: "italic", 4: "underline", 7: "inverse", 9: "strike" }[code]);
      } else if (code === 22) {
        this.flags.delete("bold");
        this.flags.delete("dim");
      } else if (code === 23) this.flags.delete("italic");
      else if (code === 24) this.flags.delete("underline");
      else if (code === 27) this.flags.delete("inverse");
      else if (code === 29) this.flags.delete("strike");
      else if (SGR_COLORS[code] !== undefined) this.fg = code;
      else if (code === 39) this.fg = null;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.bg = code;
      else if (code === 49) this.bg = null;
      else if (code === 38 || code === 48) {
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
      const cls = cell.cls ?? "";
      let j = i;
      let text = "";
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

function durationOf(run) {
  if (!run) return "—";
  const start = run.startedAt ?? run.createdAt;
  if (!start) return "—";
  return fmtDur((run.finishedAt ?? Date.now()) - start);
}

function toast(msg, kind = "info") {
  const t = el("div", { class: `toast toast-${kind}`, text: msg });
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("is-on"));
  setTimeout(() => {
    t.classList.remove("is-on");
    setTimeout(() => t.remove(), 240);
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
  $("health").className = "led led-up";
  $("health").title = "本地服务已连接";

  if (!S.providers.find((p) => p.id === S.selectedId)) S.selectedId = S.providers[0]?.id ?? null;

  renderProviders();
  renderModelArea();
  renderHistory();
  renderHead();
  syncRunBtn();
  if (!S.run) renderIdle();

  if (st.activeRunId && !S.run) attachRun(st.activeRunId);
}

function currentProvider() {
  return S.providers.find((p) => p.id === S.selectedId) ?? null;
}

/* ================================================================ 供应商 */

function renderProviders() {
  const list = $("provider-list");
  list.replaceChildren();
  $("provider-empty").hidden = S.providers.length > 0;

  for (const p of S.providers) {
    const on = p.id === S.selectedId;
    list.append(
      el(
        "li",
        {
          class: `channel${on ? " channel-on" : ""}`,
          tabindex: "0",
          onclick: (e) => {
            if (e.target.closest(".icon-btn")) return;
            selectProvider(p.id);
          },
          onkeydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectProvider(p.id);
            }
          },
        },
        el(
          "div",
          { class: "channel-top" },
          el("span", { class: "channel-name", text: p.name }),
          el(
            "div",
            { class: "channel-acts" },
            el("button", { class: "icon-btn", type: "button", text: "编辑", onclick: () => openDialog(p) }),
            el("button", {
              class: "icon-btn",
              type: "button",
              text: "删除",
              onclick: async (e) => {
                e.stopPropagation();
                if (!confirm(`删除供应商「${p.name}」？运行记录会保留。`)) return;
                await api(`/api/providers/${p.id}`, { method: "DELETE" });
                if (S.selectedId === p.id) S.selectedId = null;
                await refresh();
              },
            }),
          ),
        ),
        el("div", { class: "channel-host", text: hostOf(p.baseUrl) }),
        el(
          "div",
          { class: "channel-foot" },
          el("span", { class: "channel-key", text: p.keyMasked }),
          p.models.length ? el("span", { text: `${p.models.length} 个模型` }) : null,
        ),
      ),
    );
  }
}

function selectProvider(id) {
  S.selectedId = id;
  LS.set("fpd.provider", id);
  renderProviders();
  renderModelArea();
  renderHead();
  syncRunBtn();
  if (!S.run) renderIdle();
}

function openDialog(provider = null) {
  S.editingId = provider?.id ?? null;
  $("dialog-title").textContent = provider ? "编辑供应商" : "新增供应商";
  $("pv-name").value = provider?.name ?? "";
  $("pv-baseurl").value = provider?.baseUrl ?? "";
  $("pv-apikey").value = "";
  $("pv-apikey").placeholder = provider ? "留空则不修改" : "sk-...";
  $("pv-keyhint").textContent = provider ? `当前 ${provider.keyMasked}` : "";
  $("provider-dialog").showModal();
  setTimeout(() => ($("pv-name").value ? $("pv-baseurl").focus() : $("pv-name").focus()), 30);
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
    toast("已保存", "ok");
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
  const recent = recentModels().slice(0, 5);
  for (const m of recent) {
    chips.append(
      el("button", {
        class: "chip",
        type: "button",
        text: m,
        onclick: () => {
          $("model").value = m;
          LS.set("fpd.model", m);
          updateCmd();
        },
      }),
    );
  }
  if (!recent.length) chips.append(el("span", { class: "chip-hint", text: "最近测过的模型会留在这里" }));
}

/* ================================================================ 眉板 */

function statusOf(run) {
  if (!run) return { text: "待机", led: "led-idle" };
  const running = run.status === "queued" || run.status === "running";
  if (running) return { text: STATUS_TEXT[run.status], led: "led-run" };
  if (run.status === "cancelled") return { text: "已取消", led: "led-idle" };
  if (run.status === "error") {
    if (run.exitCode === 1) return { text: "未评分", led: "led-warn" };
    return { text: "失败", led: "led-bad" };
  }
  if (run.exitCode === 0) return { text: "已完成", led: "led-ok" };
  if (run.exitCode === 1) return { text: "未评分", led: "led-warn" };
  return { text: "已完成", led: "led-ok" };
}

function renderHead() {
  const host = $("run-head");
  if (!host) return;
  const run = S.run;
  const st = statusOf(run);
  const live = run && (run.status === "queued" || run.status === "running");
  const cols = run?.options?.cols ?? (Number($("opt-cols").value) || 110);

  const bits = [
    el("span", { class: `led ${st.led}` }),
    el("span", {
      class: `scope-state${live ? " is-live" : run && run.status === "error" ? " is-bad" : ""}`,
      text: st.text,
    }),
  ];

  if (!run) {
    const p = currentProvider();
    bits.push(el("span", { class: "scope-sep" }));
    if (p) {
      bits.push(el("span", { class: "scope-target", text: p.name }));
      bits.push(el("span", { class: "scope-sep" }));
      bits.push(el("span", { class: "scope-target", text: hostOf(p.baseUrl) }));
    } else {
      bits.push(el("span", { class: "scope-target", text: "未选择供应商" }));
    }
    bits.push(el("span", { class: "scope-push" }));
    bits.push(el("span", { class: "scope-read", text: `${cols} 列` }));
  } else {
    bits.push(el("span", { class: "scope-sep" }));
    bits.push(el("span", { class: "scope-read", text: run.model }));
    bits.push(el("span", { class: "scope-sep" }));
    bits.push(el("span", { class: "scope-read", text: durationOf(run) }));
    bits.push(el("span", { class: "scope-sep" }));
    bits.push(el("span", { class: "scope-read", text: run.exitCode != null ? `exit ${run.exitCode}` : "exit —" }));
    bits.push(el("span", { class: "scope-push" }));
    bits.push(el("span", { class: "scope-read", text: `${cols} 列` }));
    if (live) {
      bits.push(
        el("button", {
          class: "btn btn-quiet btn-xs btn-stop",
          type: "button",
          text: "取消",
          onclick: async () => {
            await api(`/api/runs/${run.id}/cancel`, { method: "POST" });
            toast("已请求取消", "info");
          },
        }),
      );
    }
  }

  host.replaceChildren(...bits);
}

function syncRunBtn() {
  const busy = S.run && (S.run.status === "queued" || S.run.status === "running");
  const p = currentProvider();
  $("run-btn").disabled = !p || busy;
  $("run-btn").textContent = busy ? "检测中…" : "开始检测";
}

/* ================================================================ 选项 */

function collectOptions() {
  return {
    api: $("opt-api").value,
    count: Number($("opt-count").value) || 3,
    parallel: Number($("opt-parallel").value) || 3,
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
  return parts.join(" ");
}

function renderIdle() {
  const box = $("well-idle");
  if (!box || box.hidden) return;
  const p = currentProvider();
  const o = collectOptions();
  const model = $("model").value.trim();
  const rows = [
    ["供应商", p ? p.name : "未选择"],
    ["端点", p ? p.baseUrl : "—"],
    ["模型", model || "未填写"],
    ["协议", o.api],
    ["采样", `count ${o.count} / 并发 ${o.parallel} / 轮数 ${o.repeat}`],
  ];
  box.replaceChildren(
    el("p", { class: "idle-title", text: "待机" }),
    el(
      "div",
      { class: "idle-rows" },
      ...rows.map(([k, v]) =>
        el("div", { class: "idle-row" }, el("span", { class: "idle-k", text: k }), el("span", { class: "idle-v", text: v })),
      ),
    ),
    el("p", { class: "idle-hint", text: "点「开始检测」后，终端输出会实时出现在这里。" }),
  );
}

function updateCmd() {
  const host = $("cmdline");
  host.replaceChildren();
  commandString()
    .split(" ")
    .forEach((part, i) => {
      if (i) host.append(" ");
      host.append(el("span", { text: part }));
    });
}

/* ================================================================ 起跑 */

async function startRun() {
  const p = currentProvider();
  if (!p) return toast("先选供应商", "bad");
  const model = $("model").value.trim();
  if (!model) return toast("填模型名", "bad");

  saveOptions();
  LS.set("fpd.model", model);
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
  renderScope();
  syncRunBtn();
  if (run.status === "queued" || run.status === "running") openStream(runId);
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
      renderHead();
      schedulePaint();
      if (msg.status !== "queued" && msg.status !== "running") finishRun();
    } else if (msg.type === "tui") {
      if (S.loadedRunId !== runId || !S.term) return;
      S.term.write(msg.chunk);
      schedulePaint();
    } else if (msg.type === "status") {
      if (S.run) S.run.status = msg.status;
      if (msg.startedAt && S.run) S.run.startedAt = msg.startedAt;
      renderHead();
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
        if (run.status !== "queued" && run.status !== "running") {
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
  renderScope();
  syncRunBtn();
  refresh().catch(() => {});
}

function startTicker() {
  if (S.timer) return;
  S.timer = setInterval(() => {
    if (S.run) renderHead();
  }, 1000);
}

/* ================================================================ 屏幕区 */

function renderScope() {
  const run = S.run;
  const idle = $("well-idle");
  const body = $("term-body");
  const foot = $("run-actions");

  if (!run) {
    $("scope").style.setProperty("--cols", String(Number($("opt-cols").value) || 110));
    idle.hidden = false;
    renderIdle();
    body.textContent = "";
    foot.hidden = true;
    foot.replaceChildren();
    renderHead();
    return;
  }

  idle.hidden = true;
  foot.hidden = false;
  $("scope").style.setProperty("--cols", String(run.options?.cols ?? 110));
  renderHead();
  renderFoot(run);
  paint(body, S.term);
  startTicker();
}

function renderFoot(run) {
  const foot = $("run-actions");
  const running = run.status === "queued" || run.status === "running";

  const kids = [
    el("button", { class: "btn btn-quiet btn-xs", type: "button", text: "再测一次", onclick: rerun, disabled: running }),
    el(
      "button",
      {
        class: "btn btn-quiet btn-xs",
        type: "button",
        text: "查看报告",
        disabled: !run.hasReport,
        title: run.hasReport ? "打开这次运行的原始报告，不解析" : "这次没有保存报告",
        onclick: () => showReport(run.id),
      },
    ),
    el("button", { class: "btn btn-quiet btn-xs", type: "button", text: "复制命令", onclick: copyRunCommand }),
  ];
  if (run.error) kids.push(el("span", { class: "foot-note", text: run.error, title: run.error }));
  foot.replaceChildren(...kids.filter(Boolean));
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
  updateCmd();
  startRun();
}

async function copyRunCommand() {
  if (!S.run) return;
  try {
    await navigator.clipboard.writeText(commandForRun(S.run).replace("-k ••••••", "-k sk-xxx"));
    toast("命令已复制", "ok");
  } catch {
    toast("复制失败", "bad");
  }
}

async function showReport(runId) {
  const res = await fetch(`/api/runs/${runId}/report`);
  if (!res.ok) return toast("这次运行没有保存报告", "info");
  const text = await res.text();
  const dlg = el(
    "dialog",
    { class: "report-dialog" },
    el(
      "div",
      { class: "dialog-body" },
      el(
        "div",
        { class: "report-bar" },
        el("div", {}, el("h2", { text: "原始报告" }), el("p", { text: `runs/${runId}.report.json` })),
        el("button", { class: "btn btn-quiet btn-xs", type: "button", text: "关闭", onclick: () => dlg.close() }),
      ),
      el("pre", { class: "raw-json", text }),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

/* ================================================================ 台账 */

function renderHistory() {
  const box = $("history");
  box.replaceChildren();
  $("history-count").textContent = String(S.runs.length);

  if (!S.runs.length) {
    box.append(el("p", { class: "empty", text: "还没有运行记录。跑一次检测就会出现在这里。" }));
    return;
  }

  box.append(
    el(
      "div",
      { class: "ledger-head" },
      el("span", { text: "模型" }),
      el("span", { text: "供应商" }),
      el("span", { class: "ledger-time", text: "开始" }),
      el("span", { class: "ledger-num", text: "用时" }),
      el("span", { class: "ledger-num", text: "退出码" }),
      el("span", { text: "状态" }),
    ),
  );

  for (const r of S.runs) {
    const st = statusOf(r);
    box.append(
      el(
        "div",
        {
          class: `ledger-row${r.id === S.run?.id ? " is-open" : ""}`,
          tabindex: "0",
          onclick: () => {
            history.replaceState(null, "", `?run=${r.id}`);
            attachRun(r.id);
            window.scrollTo({ top: 0, behavior: "smooth" });
          },
          onkeydown: (e) => {
            if (e.key === "Enter") {
              history.replaceState(null, "", `?run=${r.id}`);
              attachRun(r.id);
            }
          },
        },
        el("span", { class: "ledger-model", text: r.model }),
        el("span", { class: "ledger-sub ledger-provider", text: r.providerName }),
        el("span", { class: "ledger-sub ledger-time", text: fmtTime(r.createdAt) }),
        el("span", { class: "ledger-num", text: durationOf(r) }),
        el("span", { class: "ledger-num", text: r.exitCode != null ? String(r.exitCode) : "—" }),
        el("span", { class: "ledger-status" }, el("span", { class: `led ${st.led}` }), st.text),
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

  $("model").addEventListener("input", () => {
    updateCmd();
    if (!S.run) renderIdle();
  });
  $("model").addEventListener("change", () => LS.set("fpd.model", $("model").value));
  $("run-btn").addEventListener("click", startRun);

  $("copy-cmd").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(commandString());
      toast("命令已复制，key 用 sk-xxx 占位", "ok");
    } catch {
      toast("复制失败", "bad");
    }
  });

  $("fetch-models").addEventListener("click", async () => {
    const p = currentProvider();
    if (!p) return toast("先选供应商", "bad");
    const btn = $("fetch-models");
    btn.disabled = true;
    btn.textContent = "获取中";
    try {
      const { models, fetched } = await api(`/api/providers/${p.id}/models`, { method: "POST" });
      await refresh();
      toast(fetched ? `拿到 ${fetched} 个模型` : "接口没返回模型列表", fetched ? "ok" : "info");
      if (models.length === 1) $("model").value = models[0];
      updateCmd();
    } catch (err) {
      toast(err.message, "bad");
    } finally {
      btn.disabled = false;
      btn.textContent = "获取列表";
    }
  });

  const onChange = () => {
    if (!S.run) renderIdle();
  };
  for (const id of [
    "opt-api", "opt-count", "opt-parallel", "opt-repeat", "opt-timeout",
    "opt-effort", "opt-tier", "opt-strict", "opt-nostream", "opt-tokenizer",
    "opt-maxprobes", "opt-cols",
  ]) {
    $(id).addEventListener("change", () => {
      saveOptions();
      updateCmd();
      renderHead();
      onChange();
    });
  }

  $("opt-strict").addEventListener("change", () => {
    if ($("opt-strict").checked && $("opt-count").value !== "3") {
      $("opt-count").value = "3";
      toast("严格模式固定 count=3", "info");
      saveOptions();
      updateCmd();
    }
  });

  const well = $("well");
  well.addEventListener("scroll", () => {
    S.stick = well.scrollHeight - well.scrollTop - well.clientHeight < 48;
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
  renderHead();
  renderScope();

  try {
    await refresh();
  } catch (err) {
    $("health").className = "led led-down";
    $("health").title = "本地服务未连接";
    toast(`连不上本地服务：${err.message}`, "bad");
  }

  const deepRun = new URLSearchParams(location.search).get("run");
  if (deepRun) {
    try {
      await attachRun(deepRun);
      const p = S.providers.find((x) => x.id === S.run?.providerId);
      if (p) selectProvider(p.id);
      if (!$("model").value && S.run) {
        $("model").value = S.run.model;
        updateCmd();
      }
    } catch {
      toast("找不到这条运行记录", "bad");
    }
  }

  setInterval(() => {
    if (!S.es && !S.run) refresh().catch(() => {});
  }, 15000);
})();
