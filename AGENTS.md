# XTE-IPTV 直播代理 (FPK) v5.0

## 项目概览
飞牛 NAS 上的 IPTV 直播代理服务。输出标准 HLS (m3u8 + TS)，无转码。
- **v5.0（当前）：修复 PC 飞牛内置播放器转圈圈 + 频道导出体验微调 + 大版本号升级**
  - **① 修复内置播放器转圈（优先级反转 bug，核心）**：日志（log26）显示 PC 飞牛桌面端（Electron，`terminal="Windows浏览器"`）看 CCTV1/太原1 时持续转圈，而 v4.1.2 不转。根因：`servePlaylist` 首载时 `warmPrefetch` 以**低优先级(priority=1)后台预取**第 0 片，播放器随后请求同一片时 `streamSegmentToClient → fetchSegment` 命中 `streaming` Map 里已在途的预取下载，**直接复用了那条仍按优先级 1 排队/运行的低优先级连接**——当 6 个回源槽位占满时它被当作最低优先级限速/排队，播放器干等（log26 证据：`分片首包到达 ttfbMs:1774, catchupBytes:3248960` 说明播放器请求时预取已偷下 3.2MB，但整片仍以预取优先级耗时 3.9s）。v4.1.2 无 DOWNLOAD_SCHED 调度器、所有回源同优先级直接发，故无此反转。修复：`fetchSegment(url, prefetch=false)` 命中一条「`inflight.prefetch===true` 且 `streamers===0`（尚无播放器挂载）且未结束」的在途下载时，中止该低优先级预取（destroy 上游）并以播放器优先级(priority=10)重新回源；已有播放器在看(streamers>0)的实时流正常复用（共享 + catch-up 补发）。`inflight` 新增 `prefetch` 标记位。
  - **② 频道导出按钮文案精简**：批量栏「导出列表」改为「导出」（2 字）；「导出选中」只导出勾选频道的行为不变。其余 v4.1.9 全部功能不改动。
- **v4.1.9：多设备同时卡顿治理 + 频道导出功能**
  - **① 全局回源并发 3→6（可配置 `maxConcurrentUpstreams`，默认 6）**：日志（log24）显示 5 设备同看（4 路 4K + 1 路 1080P）时，`maxConcurrent=3` 槽位不足，实时流排队等下载，表现为「5 个要卡会同时卡」。对比 v4.1.2（git `35a7457`）发现它**根本没有 DOWNLOAD_SCHED 调度器**，直接回源所以不卡。v4.1.9 把槽位提到 6（≥ 常见家庭并发终端数），保留播放器优先于预取的抢占逻辑。
  - **② 分片回源超时 10s→30s（`segmentUpstreamTimeoutMs`，默认 30000）**：北京卫视 4K 分片达 50-54MB，带宽争抢时单片下载 10-19s，旧硬超时（`targetDuration*1000`≈10s）会 abort 共享回源，导致同一 session 下所有客户端同时断流（log24 `fail:22`、`consecutiveFail:3/4`）。放宽到 30s 给大分片足够时间，避免误杀正常下载。
  - **③ 自适应预取（`prefetchMaxViewers`，默认 1）**：v4.1.8 放开预取后，单路流畅但多路 4K 时 54MB 大分片预取与实时流争抢带宽（log23「同时看 3 个 4K 变只能 1 个」）。v4.1.9 新增 `countActiveViewers()`：当真实观众会话 >1（多路并发）时各路**关闭预取**把带宽让给实时流；单路时积极预取。并用 EWMA `_avgSegBytes` 判断大分片（>20MB）只预取 1 片、小分片预取 3 片（`_prefetchDepth()`），每片重新评估（`_prefetchAllowed()`）。
  - **④ 频道管理页导出功能**：bulk-bar 新增「导出选中 / 导出列表 / ▾」菜单（内网代理 / 三线路合并 / 原始流地址 / 全部含已禁用）。后端 `GET /api/channels/export` 支持 `scope=all|selected|search`、`ids`、`q`、`includeDisabled`、`line=inner|ipv6|frp|all`、`raw=1`，用 `buildChannelExtinf()` 生成带 tvg-id/tvg-name/tvg-logo/group-title 的标准 M3U，`Content-Disposition: attachment` 文件名 `xte-channels-{date}-{scope}-{count}.m3u`。
- **v4.1.8：修复持续观看时频繁卡顿（预取被内存闸门饿死）**——日志（log22）显示单路 CCTV1/4K 会话正常 RSS 稳定在 638MB、每片约 10MB 回源耗时 ~5.4s（≈分片时长），但 `prefetched` 始终为 0、`miss` 持续增长、状态反复 `stalled`：播放器请求的每一片都不在缓存里，必须干等约 5s 回源，表现为频繁卡顿。根因：`_drainPrefetchQueue()` 的全局内存闸门**硬编码 600MB**，而单路 4K 会话正常就 ~638MB，导致后台预取被永久跳过。v4.1.8 将该闸门改为可配置项 `prefetchMemLimitMB`（默认 1100MB），单会话已有 96MB 字节上限（`maxCacheBytes`）兜底防 OOM，预取恢复在「播放器发完当前片之后」低优先级串行预取后续 3 片，播放器播完当前片时后续片大多已缓存、命中即零等待。注意：未采用「请求开始就并行预取」方案，因为该 4K 源回源带宽（~15Mbps）仅勉强实时，并行下载会争抢实时流带宽，反而拖慢当前片。
- **v4.1.7：stalled 假活会话自动恢复**——4K 频道在浏览器卡死时，播放器 TCP 连接未断开（`active=1`）但 mediaSeq 冻结、长时间无分片成功送达，旧 `reapSessions` 只回收 `active<=0` 的会话，导致这种「假活」会话死占内存近 18 分钟。v4.1.7 在 `reapSessions` 中新增检测：`active>0` 且 `lastSegServedAt` 距今超过 `stalledRecoverMs`（默认 60s，约 6 个分片时长）时，warn 日志后 `s.destroy({ closeClients: true })` 强制销毁会话并销毁挂死的客户端 res 连接，触发播放器自动重连重建会话。`Session.destroy` 签名改为 `destroy({ closeClients = false })`。正常播放（含 3 终端同时看 4K）不会命中。
- **v4.1.6：彻底对齐 v4.1.2「所有终端都能看」的可达性模型**——v4.1.3 起 `servePlaylist` 的分片/子清单基地址优先取「线路配置的对外地址」(`getLineBases()`)，在用户未配置 IPv6/FRP host、或实际接入 Host 与固化 `session.line` 不一致时，会把 `/proxy/ts` 指向播放器连不上的地址，导致手机/平板/TV/浏览器等终端「频道无法播放」（用户明确反馈从 v4.1.3 开始只有 PC 内置播放器能看）。v4.1.6 新增 `resolvePlaybackBase(kind, req)`：**默认一律用本次请求的 `Host`（含 `x-forwarded-proto`）**，播放器用哪个地址连上 NAS（内网 IP/FRP 公网域名/IPv6），分片就指回哪个地址；仅当线路显式配置了一个「非回环（127.0.0.1/::1/localhost）」的对外地址时才用配置（修复 FRP 网关 Host=127.0.0.1）。`/m3u/{kind}` 列表与 `servePlaylist` 统一走该函数。日志加强：`m3u8 索引返回` 新增 `base` 与 `host` 字段，直接可见分片指向哪个地址。
- **v4.1.5：修复 IPv6/FRP 标签「当前线路返回 0 个频道」**——v4.1.3/v4.1.4 对「未在后台配置对外 host」的线路返回了 200+空 m3u，导致飞牛客户端切到 IPv6/FRP 标签时拿不到任何频道（截图显示「0 个频道」）。v4.1.5 恢复 v4.1.2 行为：`/m3u/{kind}` 路由当 `bases[kind]` 为空时，**回退用本次请求的 `Host`（含 `x-forwarded-proto`）作为基地址**生成列表和分片地址。客户端用哪个地址连上 NAS（内网 IP / FRP 公网域名 / IPv6），分片就指回哪个能连上的地址，三个标签都能拿到频道；已显式配置 host 的线路仍以配置为准（最高优先级）。日志由 `被请求但线路未启用` 改为 `线路未配置，回退使用请求 Host 生成列表`。
- **v4.1.4：修复 v4.1.3 两个回归**——① **修复外网终端全部无法播放**：`servePlaylist` 生成分片/子清单 URL 时，基地址改用「该线路配置的对外基地址」(`getLineBases()`，inner=LAN IP / ipv6 / frp)，不再用请求 `Host`。经 FRP/fnOS 网关回连时 `Host=127.0.0.1`，旧版把它写进 `/proxy/ts`，手机/平板/电脑浏览器/TV 拿到的分片地址指向 127.0.0.1 根本访问不到，只有能直连内网的客户端能播；② **修复 4K 反复中断/无法观看**：移除 v4.1.3 的「持续背压 8s 即强杀上游」逻辑——它会误杀按 HLS 节奏正常消费的播放器（4K 大分片 `res.write()` 返回 false 是常态而非异常），把正在播的分片截断；改为背压时仅 `up.pause()`（内存/带宽被约束在一个缓冲内），客户端断开由 `res 'close' → removeClient` 中止上游；③ **下载调度器支持实时流抢占预取**：播放器按需流(priority=10)到来且 3 个槽位占满时，抢占一个最低优先级的运行中预取(priority=1)并销毁其上游，让出带宽，解决 PC 客户端内置播放器「隔一会卡一下」（预取占满槽位时播放器被迫排队）；被抢占的预取不计失败、不打错误日志；④ 源管理删除冗余的「本地文件」下拉（已有独立的本地上传 Tab），URL 模式下按路径前缀自动判定 local/remote。
- **v4.1.3：出口带宽争抢治理 + 源三种添加方式**——全局下载调度器 `DOWNLOAD_SCHED`（maxConcurrent=3，播放器优先于预取，记录 waitMs/globalKbps）；慢客户端 8s 中止（**v4.1.4 已移除**）；96MB 字节缓存上限；线路 `&line=` 透传；XFF 真实 IP；终端细分；会话按 lastClientAt 30s 回收；源支持远程 URL/本地上传/文本粘贴（内容落盘 `DATA_DIR/sources/`，删除时清理）；全选复选框修复。
- **v4.1.1：卡顿与 IPv6 修复**——双栈监听；未命中分片流式回源（首包即发）；索引刷新节流 3s + 序号守护（拒绝 mediaSeq 回退）+ 失败退避；预取串行队列（深度 3）防 CDN 限流；保活只刷新不预取；逐频道状态汇总日志。
- **v4.1.0**：统一「智能缓冲」模式——删除透传 / 缓存 / 直连 / 原生所有模式开关，所有播放都经 XTE 代理一条链路。
- v4.0.3：修复 direct 模式原样透传 m3u8 导致分片绕过代理的核心问题（分片/子列表/KEY 地址全部改写为走 XTE 代理）。

## 核心运行原理（务必理解）
代理链：客户端 → `/m3u/inner.m3u8`（频道列表，每频道 `/play/{id}.m3u8`）→ `/play/{id}.m3u8`（`servePlaylist`：建会话、节流刷新索引、把分片改写为 `/proxy/ts?sid=...&url=...`，子 m3u8 改写为 `/proxy/m3u8?url=...`，EXT-X-KEY/MAP 的 URI 也走 `/proxy/ts`）→ `/proxy/ts`（`serveSegment`：按 sid 找会话；命中缓存立即回；未命中 `streamSegmentToClient` 流式回源边下边缓存；流式建连失败再 `fetchSegmentWithRetry`；彻底失败标记坏片并插 EXT-X-DISCONTINUITY，返回 204 不中断播放）。
- **智能缓冲关键机制（v4.1.1）**：① 非阻塞索引刷新（已有缓存索引立即返回旧索引，后台 refresh）；② 回源节流（同会话两次 m3u8 刷新至少间隔 `refreshMinIntervalMs=3000`，失败指数退避）；③ 序号守护（拒绝 mediaSeq 比当前小的旧清单）；④ 串行预取（`_prefQueue` 单消费者，深度 `prefetchAhead=3`）；⑤ 分片流式回源（首包即写客户端，背压 pause/resume）；⑥ 分片失败重试（segRetry=3 + 刷新索引后再试）。
- **稳定分片标识**：`segKey(url)` 取 `URL.pathname`，去掉查询串中的动态 token/时间戳/签名，让时效源的同一片能跨请求命中缓存。
- 相对地址必须用 `absUrl(u, baseUrl)` 解析成绝对地址后再改写，否则 `/proxy/ts?url=相对路径` 无法回源。
- fetchText 自动 gunzip/inflate/brotli，fetchUpstream 默认发 `Accept-Encoding: identity`。
- **IPv6/双栈**：`server.listen(PORT, '::')` 在 Linux 默认 `bindv6only=0` 下同时接受 IPv4/IPv6；回源 IPv6 字面地址在 `fetchUpstream` 去方括号并设 `family:6`。

## 内置最优参数（v4.1.3，不在 UI 暴露）
| 参数 | 值 | 说明 |
|------|----|------|
| cacheWindow | 12 | 会话内存缓冲窗口（片） |
| maxCacheBytes | 96MB | 会话内存缓冲字节上限，4K 大分片按 FIFO 淘汰防 OOM |
| prefetchAhead | 3 | 当前片之后串行预取 3 片 |
| refreshMinIntervalMs | 3000 | m3u8 回源节流最小间隔 |
| keepAliveIntervalMs | 4000 | 保活定时器周期（只刷新索引） |
| activeWindowMs | 20000 | 最近有真实观众的时间窗，门控后台预取/保活 |
| sessionTtlMs | 30000 | 空闲会话 30s 回收（按 lastClientAt 真实观众） |
| segmentTtlMs | 45000 | 分片缓存 45s |
| segRetry | 3 | 单分片失败重试次数 |
| segRetryIntervalMs | 500 | 重试间隔 |
| prefetchMemLimitMB | 1100 | 预取全局内存闸门(MB)，超过才暂停预取（v4.1.8 从硬编码 600 提升） |
| prefetchMaxViewers | 1 | 真实观众会话数 > 此值时各路关闭预取，把带宽让给实时流（v4.1.9 新增，多路 4K 不互抢） |
| maxConcurrentUpstreams | 6 | 全局回源并发上限（v4.1.9 从 3 提升；旧值在 5 设备同看时排队集体卡）。映射到 DOWNLOAD_SCHED.maxConcurrent |
| segmentUpstreamTimeoutMs | 30000 | 单片回源超时(ms)（v4.1.9 新增；旧硬超时≈targetDuration*1000=10s 会误杀 54MB 的 4K 大分片并 abort 共享回源） |
| stalledRecoverMs | 60000 | stalled 自动恢复：有连接但超此时长无分片送达即断开重连（v4.1.7，0=关闭） |
| DOWNLOAD_SCHED.maxConcurrent | 6 | 全局回源并发上限（播放器优先于预取；v4.1.9 起取 maxConcurrentUpstreams） |
| KEEP_AGENT | maxSockets=128/maxFreeSockets=32/timeout=60000 | HTTP keep-alive 连接池（v4.1.4 已移除背压 8s 强杀，改为背压 pause/resume） |


## 关键实现注意事项（踩坑记录）
- **PC 客户端内置直播播放器（飞牛桌面端 = Electron）占用电脑资源/越看越卡**：日志（log25）显示该终端（`terminal="Windows浏览器"`，UA 含 windows，Electron 内核）看 CCTV1（10MB/片，~1870KB/s）时 `slowClient:false`、`hit` 持续增长、`buffered:9`，**服务端链路完全健康**；卡顿与高资源占用发生在客户端。根因：Chromium 不原生支持 HLS，飞牛内置播放器在 Electron 渲染进程用 JS（hls.js 类库）做 TS demux + MSE 灌入，直播长时间观看时 MSE `SourceBuffer` 未及时 evict 已播段 → 渲染进程内存/GPU 内存持续增长，主线程 demux 工作挤占导致整台电脑卡顿；这是客户端实现问题，代理侧无法修复。建议用户改用系统级播放器（VLC/PotPlayer/mpv，硬解 + 原生 HLS/TS 支持）订阅 `http://<NAS内网IP>:34500/m3u/inner.m3u8`，或在飞牛客户端设置里开启/关闭硬件加速对比。服务端对该类终端**不做**列表截断/节流（会牺牲其他终端的起播与抗抖动），保持现状。
- **IPv6 回源**：`new URL('http://[v6]/...').hostname` 在 Node 中**带方括号**返回 `"[v6]"`，直接传给 `http.request({hostname})` 会触发 `getaddrinfo ENOTFOUND [v6]`。必须 `replace(/^\[|\]$/g,'')` 去括号并设置 `family:6`。见 `fetchUpstream` 的 `doReq`。
- **台标解析**：直播源 EXTINF 属性写法不统一，`parseExtinf` 必须同时兼容 `key="v"`、`key='v'`、`key=v`（无引号）三种。
- **中文域名**：用 `url.domainToASCII` 做 IDN→Punycode；保存线路 host 与所有回源 URL 均经 `toAsciiHost` 归一化，前端预览用 `toAsciiHostFE`。

## 技术栈
- **运行时**: Node.js（fpk 内由 fnOS 提供 nodejs_v18+）
- **后端**: 原生 `http`/`https`，零第三方依赖
- **前端**: 原生 HTML/CSS/JS（单页，无框架）
- **部署**: FPK（gzip USTAR tar），端口 34500（manifest service_port）

## 文件结构
```
app/server/main.js     # 全部后端：智能缓冲内核/会话缓存/预取容错/API/静态服务（单文件）
app/www/index.html     # 管理界面（仪表盘/源管理/频道/设置/日志）
app/ui/                # 桌面快捷方式图标
manifest               # FPK 元信息（version=4.1.0, service_port=34500）
ICON.PNG / ICON_256.PNG
cmd/                   # 9 个 fnOS 生命周期脚本（main 负责启动/守护/停止）
config/                # privilege, resource
```
数据目录由 `DATA_DIR`（fnOS 下为 `${TRIM_PKGVAR}/data`）注入，运行时写入：`config.json`、`sources.json`、`channels.json`。

## 构建与运行
```bash
# 本地运行（沙箱）
DEPLOY_RUN_PORT=5077 DATA_DIR=/tmp/xte-data node app/server/main.js

# 语法检查
node --check app/server/main.js

# 打包 FPK（产物输出到项目根 /workspace/projects/xte-4.1.0.fpk）
python3 /tmp/mkfpk.py /workspace/projects/xte-4.1.0.fpk
```
FPK 必须是 gzip 压缩 USTAR tar，magic `1f 8b 08 08`（gzip flag=FNAME），内含 `app.tgz` + `manifest` + `ICON*.PNG` + `cmd/*` + `config/*`。`app.tgz` 内文件必须在包根（server/main.js、www/...），不能多一层 app/ 目录。**下载用的 fpk 必须放在 /workspace/projects/ 根目录**（Python http.server 根是项目根，public/ 子目录会 404）。

## 核心设计

### 统一智能缓冲内核（v4.1）
- 所有播放经 XTE 代理一条链路，无模式开关；`pipeUpstream()` 仅在会话丢失/索引刷新异常时做字节级兜底。
- `SegmentSession` 按频道 URL 建立，分片本地缓存 + 后台预取 + 失败重试；`session.mode` 恒为 `'smart'`。
- 兼容所有带时效签名/鉴权的运营商源（分片经代理转发，客户端无需直连源站）。

### 缓冲子系统（SegmentSession）
- **首载预热**：首次 `servePlaylist` await 一次 refresh 后 `warmPrefetch(0)` 预拉前 N 片。
- **非阻塞刷新**：已有索引时 m3u8 请求立即返回旧索引，后台 `refresh()`，把回源延迟移出播放器关键路径。
- **保活预热**：4s 定时器刷新所有活跃会话并 `warmPrefetch(末尾 N 片)`，播放器永远拿到已回源好的列表。
- **按需预拉取**: `prefetchAhead(currentUrl)` 定位当前片在最新索引中的位置，异步续拉后 6 片；当前片不在索引（旧序号）时回退 `warmPrefetch(0)`。
- **TTL 时效**: `segmentTtlMs`=45s 过期即剔除，`get()` 读取时校验，绝不返回过期分片。
- **滑动窗口**: `cacheWindow`=24 片，超出淘汰最旧。
- **并发去重**: `fetching` Map 保证同分片只回源一次。
- **缓存 key**: `segKey()` = URL.pathname（去除查询串动态签名/token）。

### 全链路容错
- 分片失败重试 `segRetry`=4 次，间隔 `segRetryIntervalMs`=300ms。
- 重试仍失败 → `refresh()` 刷新索引拿到最新地址 → 再试 1 次。
- 彻底失败 → 加入 `badKeys`，`rewriteMediaPlaylist()` 在坏片处插 `EXT-X-DISCONTINUITY` 平滑跳过，`serveSegment` 返回 204。
- 连续失败仅记录并退避（`noteFailure`/`noteSuccess`），不切模式不清缓存，源站抖动恢复后自动归零。

### 会话生命周期
- 180s 空闲回收（`sessionTtlMs`）；m3u8/TS 请求（无论成败）均 `touch()` 重置计时。
- `active` 活跃连接计数；回收前 `isIdle()` 二次校验，有活跃连接不回收。
- 每 15s 扫描 `reapSessions()`；`destroy()` 置 `destroyed` 标志，保活定时器据此跳过。

### 日志
- 内存环形缓冲 `logBufferSize`=500，分 info/warn/error，错误自动分类：timeout/404/403/5xx/connection/parse/unknown（`classifyError()`）。
- API `/api/logs` 查看、`/api/logs/export` 导出。

## 路由与 API
| 路径 | 方法 | 说明 |
|------|------|------|
| `/m3u`、`/m3u/inner\|ipv6\|frp\|all.m3u8` | GET | 主播放列表（频道 URL 改写为 `/proxy/m3u8?url=...`） |
| `/play/{id}.m3u8` | GET | 单频道索引（建会话、非阻塞刷新、分片改写为 `/proxy/ts?sid=...`） |
| `/proxy/m3u8?url=` | GET | 频道索引/嵌套多码率子 m3u8（继续改写） |
| `/proxy/ts?url=&sid=` | GET | 分片（命中缓存秒回 / 未命中回源+预取，失败 204） |
| `/api/status` | GET | 仪表盘：version/mode=smart/频道数/会话数/内存/运行时长 |
| `/api/sessions` | GET | 会话明细与缓冲统计（hit/miss/prefetched/fail） |
| `/api/config` | GET/POST | 读写配置（仅 refreshIntervalMin 等暴露；缓冲参数内置） |
| `/api/sources` | GET/POST | 源列表/添加（远程 URL 或本地文件） |
| `/api/sources/:id` | PATCH/DELETE | 编辑/删除源 |
| `/api/sources/refresh` | POST | 刷新源（带 id 刷新单个，否则全部） |
| `/api/channels?page&size&q` | GET | 频道分页/搜索 |
| `/api/channels/:id` | PATCH | 编辑频道字段（名称/台标/分组/启用等，无 runMode） |
| `/api/logs` `/api/logs/export` | GET | 日志查看/导出 |

源自动刷新周期 `refreshIntervalMin`（默认30分钟，0=关闭）。刷新时按 URL 去重并保留用户对频道的编辑（名称/台标/分组/启用状态）。

## 端口与环境变量
- 端口读取顺序：`DEPLOY_RUN_PORT` > `TRIM_SERVICE_PORT` > `FPK_SERVICE_PORT` > `PORT` > 34500。沙箱用 DEPLOY_RUN_PORT，fnOS 用 TRIM_SERVICE_PORT。
- `DATA_DIR`：数据目录。
