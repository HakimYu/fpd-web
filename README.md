# fpd-web · 模型指纹检测的本地图形界面

把这条命令变成一个界面：

```sh
bunx lmfpd@latest -b https://api.openai.com/v1 -k sk-123 -m gpt-6.1-sol
```

界面上的顺序是：选供应商、选模型、开始检测、看终端输出。

## 启动

```sh
cd fpd-web
bun server.ts          # 或 bun dev（热重载）
# → http://127.0.0.1:5273
```

第一次打开时先在「供应商」一栏点「新增」，填一组 base url 和 api key。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `5273` | 本地端口 |
| `LMFPD_SPEC` | `lmfpd@latest` | 检测包，建议锁版本：`lmfpd@0.0.1792416845676` |

> 它的版本号是日期戳，上游随时会改输出。长期用建议锁版本。

## 核心设计：PTY + 终端回放

lmfpd 是个 Ink 写的全屏 TUI。上一版用 `--json` 拿报告，代价是点完按钮后二十秒什么都不动——JSON 只在结束时输出一次。

现在给它一个真 PTY，把它画出来的 ANSI 流原样推给浏览器，由前端做终端回放：

```
浏览器（原生 JS + 200 行小终端）
   │  SSE，只监听 127.0.0.1
   ▼
server.ts（Bun.serve + Bun.spawn，单文件零依赖）
   │  Bun.spawn(..., { terminal: { cols, rows, data } })
   ▼
bunx lmfpd@latest --no-update-check --output runs/<id>.report.json
```

测试过程中看到的就是它本来的样子：`⠼ Streaming 92/305`、`TTFT 3.3s · 144 tok/s`、进度条、候选排名表、`× Failed / HTTP 401`、`Saved ...json`。颜色全是它自己发的 SGR，前端只负责还原。

前端那个小终端（`Term` 类）实现了 Ink 实际用到的子集：

- 字符、`\r`、`\n`、`\b`、`\t`
- CSI `A/B/C/D/E/F/G/H/f`（光标移动）、`K`（清行）、`J`（清屏）
- SGR `m`：30–37 / 90–97 前景、40–47 / 100–107 背景、bold / dim / italic / underline / inverse / strike
- 忽略 `?25l/h`、`?2026h/l` 和 OSC 8 超链接

Ink 的重绘方式是“光标上移 N 行 + 清行 + 重写”，所以必须按行缓冲回放。直接往 `<pre>` 里 append，屏幕会滚成几百帧残影。

## 界面里有什么

**供应商**：左栏一组 `base url` + `api key` + 名字，可以并列多个。key 只存本机 `data/providers.json`（权限 600），接口只回遮罩值。点「获取列表」会打 `GET {base}/models` 存下模型列表，之后从模型输入框的补全里选；跑过的模型也会自动记住。

**检测**：模型名、可折叠的「检测参数」（`-a / --count / -p / -n / --strict / -ns / --timeout / -e / -t / --tokenizer / --max-probes`），以及终端宽度 cols（80–160，直接影响 Ink 的排版宽度）。参数存 localStorage。左栏底部回显等效命令行，「复制命令」把它复制出去，key 用 `sk-xxx` 占位。

**屏幕**：空闲时显示待命读数——供应商、端点、模型、协议、采样参数，开始前就能核对待测目标。跑起来就是 PTY 的实时流，上方一行状态（检测中 / 已完成 / 未评分 / 失败 / 已取消，带用时和退出码），右端是取消按钮（发 SIGTERM）。下方三个按钮：再测一次、查看报告、复制命令。

**运行记录**：台账样式，列出模型、供应商、开始时间、用时、退出码和状态。每条 `runs/<id>.json` 存着完整 ANSI 流，点开重放当时的画面，不重新发请求；支持深链 `?run=<id>`。

**原始报告**：仍然用 `--output` 落盘到 `runs/<id>.report.json`，点「查看报告」原样打开。不解析，只是留档。

## 安全

- key 不进命令行：走 `API_KEY` / `BASE_URL` / `MODEL` 环境变量，`ps aux` 看不到。
- 不拼 shell 字符串，参数数组传参，防注入。
- 只绑 `127.0.0.1`，校验 `Host` / `Origin`，防 DNS rebinding。
- 单槽队列：一次只跑一个检测（一轮就有十几个请求）。
- `data/`、`runs/` 已在 `.gitignore` 里。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 至少一轮出了排名 |
| 1 | 有报告但某轮没被评分（回答不合格 / 被截断 / 接口报错） |
| 130 / 143 | 取消（Ctrl+C / SIGTERM）—— `--output` 仍会保存已收到的样本 |

## 取舍

- 只支持单机单用户，别往 `0.0.0.0` 上绑。
- 判定结果是参考库内的相对排名，不是上游模型身份的证明。工具自己也这么说：*Confidence is relative to models in the reference bank and does not establish the upstream model's identity.*
- 长跑时 ANSI 流很大，每次重绘都全量发。服务端只留最后 400KB，前端缓冲区留 600 行，够看，也不会撑爆内存。
