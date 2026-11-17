# 更新日志

## v5.2.2 (2026-11-17) — 内存泄漏治理（RSS 6.3GB）

现场：飞牛 NAS 连续运行 13h50m 后，`node server/main.js` 的 RSS 达 **6,624,732 kB（6.32GB）**，
而同一时刻 `process.memoryUsage().heapUsed` 只有 **74MB**，34500 端口活动连接为 0 —— 是堆外 Buffer 滞留，不是 JS 堆泄漏。
本版按「封住已知无界路径 + 全局预算 + 看门狗兜底」三层治理，并加了内存诊断日志方便下次直接定位。

### 已确认并封住的无界路径（本机实测复现）
1. **分片在途缓冲无上限**：`fetchSegment` 把上游数据全部塞进 `inflight.chunks`，只有上游 `end` 才 `Buffer.concat`。
   若分片地址实际是「永不结束的直播流」或源站不收尾，chunks 会按回源速度无限增长——
   本机用 4MB/s 的假分片复现：**60 秒就把 RSS 从 123MB 顶到 325MB，且客户端断开后不回落**。
   现在 `maxInflightMB`（默认 64MB）超限立即中止回源（播放器自动重试下一片），
   `sweepInflight()` 每 5s 清扫「20s 无新数据」或「存活超 180s」的在途分片。
   实测同一条假分片在 64MB 处被中止，RSS 稳定在 137MB。
2. **拼接后双份驻留**：`Buffer.concat` 后未释放 `chunks`，54MB 分片峰值要占 ~108MB。
   现在 concat 后立即 `chunks.length = 0`。
3. **每会话缓存无全局预算**：旧版每会话 96MB，N 路会话叠加无上限。新增跨会话总预算
   `globalCacheMB`（默认 192MB）与 `trimGlobalCache()`，超出按「最久未用」跨会话淘汰。
4. **大分片缓存纯亏**：4K 单分片 40~60MB，缓存里最多躺 1 片（现场日志 `hit:0, miss:142` 铁证命中率恒为 0），
   却要额外占 1~2 倍内存。新增 `segCacheMaxMB`（默认 24MB）：超限分片不写缓存、只直传播放器；
   同时关掉这类分片的预取（`_prefetchAllowed()`），省带宽也省内存。
5. **僵尸会话永不回收**：旧 `reapSessions()` 要求「`active<=0`」或「`lastSegServedAt` 有值」才回收，
   于是「播放器连上就挂死（active>0、从未送达分片）」的会话永久驻留；而汇总日志又把它判为「不可见」不打日志，
   能挂一整夜持续吃内存。现在以「最后一次真实活动」（客户端请求 / 分片送达 / 在途下载仍有数据）判定，
   超过 `stalledRecoverMs`(60s) 一律强制销毁并断开挂死连接；`destroy()` 同时补清 `badKeys`/`lastSegs`/`playlistRaw`。

### 新增内存看门狗（兜底任何未知泄漏）
- 每 15s 采样，`/api/status` 新增 `mem` 明细（rss/heap/external/arrayBuffers/会话数/在途字节/缓存字节）。
- 每 5 分钟写一条「内存诊断」日志（空闲时也写），下次异常可直接对照时间线。
- `memSoftLimitMB`(700) 超线：清空闲会话缓存 + 中止停滞回源，不改播放；
  `memHardLimitMB`(1300) 超线且当前无观众：**自动退出**，守护循环 3s 内拉起（飞牛现网实测有效）；
  有人在看则继续观察；`memForceLimitMB`(2600) 即使有人在看也重启，优先保整机。
- `cmd/main` 启动 node 时加 `MALLOC_ARENA_MAX=2`，减少 glibc 多 arena 碎片导致的 RSS 虚高。

### 验证
- 40MB 大分片播放 4 分钟：RSS 87→255MB 后**完全持平**（旧版同场景会持续增长），缓存恒为 0 不浪费。
- 真 4K 频道（3840x2160 hevc）连播 3 分钟：RSS 峰值 216MB，缓存 63MB，命中正常（hit 6/miss 26），停止后缓存归零。
- 真 CCTV1（1080p）：`ffprobe` h264+aac 正常，预取/缓存命中正常，无回归。
- 永不停歇的假分片：64MB 处中止，RSS 137MB 持平（旧版无上限）。
- 看门狗：把阈值调到 150/200MB，实测依次打出「清理空闲缓存」→「有观众暂不重启」→「无观众自动重启」，进程按预期退出。

## v5.2.1 (2026-11-11) — 修复「导入源后电视直播看不了」

实测环境：fnOS NAS（192.168.31.101，含 docker0/br-*/tailscale 多网卡），导入两份直播源
（iFansClub 聚合源 852 个频道 + 山西移动源 433 个频道），用 ffmpeg/ffprobe 模拟电视端播放器回归。

### 致命修复
1. **代理地址补回扩展名（全端不可播的根因）**
   - 现象：`ffmpeg -i http://NAS:34500/play/<id>.m3u8` 直接失败：
     `URL .../proxy/ts?sid=..&url=.. is not in allowed_segment_extensions`
   - 原因：分片地址路径是 `/proxy/ts`（无扩展名），ffmpeg 系 HLS 解析器按扩展名白名单拒收，
     电视盒子/Kodi/mpv/TiviMate 几乎都是 ffmpeg 内核 → 所有频道都播不了。
   - 修复：分片 `/proxy/ts/<sid>.ts`、子清单 `/proxy/m3u8/<sid>.m3u8`、密钥 `<sid>.key`、
     初始化段 `<sid>.mp4|.ts`；路由兼容旧格式（老播放器缓存里的旧地址仍可用）。
   - 回归：CCTV1（央视频中继）与山西移动 CCTV1 均 `ffprobe` 出 `h264 1920x1080 + aac`，`ffmpeg -t 8` 无错误。

2. **内网地址探测拿到 docker0 的 172.17.0.1（电视根本连不上）**
   - 旧实现遍历网卡取「最后一个私网 IPv4」，在本机实际返回 `172.17.0.1` →
     `/m3u/inner.m3u8` 里 1239 个频道地址全部指向 docker 网桥，局域网电视必然超时。
   - 修复：优先 `/proc/net/route` 默认路由网卡的地址；跳过 `docker/br-/veth/tailscale/zt/tun` 等；
     `resolvePlaybackBase()` 在「内网线路未显式填 host」时优先用**本次请求的 Host**（含 `x-forwarded-host`）；
     新增 `XTE_LAN_IP` 环境变量可手工钉死。实测 `线路基地址 inner` 由 `172.17.0.1` 变为 `192.168.31.101`。

### 播放链路健壮性
3. **非 HLS 上游不再输出垃圾清单**：上游返回错误页/「需登录」文本时，旧版会把它改写成一条
   `/proxy/ts?url=<错误文案>` 丢给播放器（既无 `#EXTM3U` 也无 `#EXTINF`）。现要求上游必须含
   `#EXT-X-TARGETDURATION` / `#EXT-X-STREAM-INF` / `#EXT-X-MEDIA-SEQUENCE` / `#EXT-X-PLAYLIST-TYPE` /
   `#EXT-X-ENDLIST`，否则回 `502` + 原因；`SegmentSession.refresh()` 同步校验，绝不覆盖上一份可用索引。
4. **渐进式媒体直链**：mp4/flv/mkv 等非 HLS 频道在播放列表里直接给 `/proxy/ts/<id>.<ext>?url=`，
   保留客户端 `Range` 头（可拖动），不再当播放列表解析（公告/教程/回看频道恢复可播）。
5. **多码率主清单的音轨 URI**：`#EXT-X-MEDIA`（以及 `#EXT-X-I-FRAME-STREAM-INF`/`#EXT-X-SESSION-KEY`）
   的 `URI=` 此前未改写，播放器会去 XTE 上找 `/ysp-vip/xxx/audio.m3u8` → 404（有画面没声音/黑屏）。
6. **「按频道 ID 聚合」的源**：iFansClub 这类 `/629942219` 端点把子清单写成相对路径 `01.m3u8`，
   服务端实际按「频道目录」提供；旧版按 RFC 解析到 `/01.m3u8`，上游回 `地址格式错误`。
   现当基地址末段是纯数字频道 ID 且相对地址不含 `/` 时按目录方式解析。
7. **`#EXTINF` 解析**：标题按「引号外最后一个逗号」切分（台名含逗号不再截断）；
   兼容 `#EXTGRP:` 分组标签、UTF-8 BOM，避免导入后分组/台名错乱。

### 新增功能
8. **频道可用性检测**：`POST /api/channels/check`（后台任务，并发 6）+ `GET /api/channels/check`（进度），
   频道管理页新增「检测可用性」按钮，完成后可一键批量停用不可用频道。
   判定 = 播放列表必须是真 HLS + 试拉首个分片前 2KB。实测 117 个 CCTV 频道 14s 完成（100 可用 / 17 不可用）。

### 导入体验（针对「加了源却 0 频道」）
10. **源刷新错误人话化**：`ECONNRESET`/超时/`ENOTFOUND`/403/404/非 M3U 等错误翻译成可执行提示并落库到源记录
    （例：*源站连接被重置（raw.githubusercontent.com）：地址在当前网络已无法访问…… 请改用「本地上传」或「文本粘贴」导入*），
    源管理页用红色徽标 + 悬浮完整原因展示，不再只显示 `read ECONNRESET`。
11. **回源自动 IPv4 回退**：双栈环境里 IPv6 路由不通（DNS 先返回 AAAA、连接被 RST）时，自动改用 IPv4 重试一次
    （国内访问 GitHub raw 等典型场景）。

### 打包
9. 改用 **飞牛官方 `fnpack`（v1.2.4）** 打包，产物 `dist/xte-5.2.1-x86_64.fpk`、`dist/xte-5.2.1-aarch64.fpk`
   （`app.tgz` + `manifest`(含 checksum) + `cmd` + `config` + `wizard` 标准结构，两架构仅 `platform` 不同）。

### 已知上游问题（非本软件缺陷，已用上游原始地址交叉验证）
- iFansClub 聚合源中「央视频 VIP / 咪咕体育赛事 / 慢直播摄像头」大量频道上游已下线或需登录
  （直连返回 401/403、「需登录后观看」、「地址格式错误」），抽样 20 个中 8 个可播；
  山西移动源抽样 20/20 可播。死频道现在会被明确报错，并可用「检测可用性」一键停用。

---

## v5.2.0 (2026-09-14)
- 修复设置管理账户密码后登录无法进入主界面（登录会话改为 HttpOnly Cookie，整页导航也能保持登录态）。
- 频道导出支持四种地址方式：原始播放地址、内网地址、DDNS/IPv6 地址、FRP 地址，导出选中或全部均可任选。

## v5.1.1
- 修复添加源/刷新失败（`(intermediate value).catch is not a function`）导致频道列表为空。

## v5.1.0
- 管理后台新增用户名/密码认证（会话 token + HttpOnly Cookie）。

## v5.0.3
- 修复部分设备安装后白屏：桌面入口由 `iframe` 改为新窗口直连，规避混合内容拦截。
- 按架构拆分 x86 / ARM 安装包。

## v5.0.2
- 修复电视/平板/手机等非 PC 终端不能看：观众活动窗口 `activeWindowMs` 恢复 45s、会话 TTL 恢复 90s
  （旧配置启动时强制迁移到安全下限）。

## v5.0.1
- 回退 v5.0 的「预取提权」逻辑（会把每个预取分片销毁并重新下载），对齐 v4.1.2 在途下载复用。

## v5.0.0
- 频道导出（选中/列表/原始地址/多线路合并）、批量栏「导出」入口（**该版本存在致命预取 bug，请勿使用**）。

## v4.1.x
- 智能缓冲内核：分片预取、失败重试、坏片 `EXT-X-DISCONTINUITY` 跳过、索引刷新节流与序号守护、
  三线路（内网/IPv6/FRP）地址自动适配、多终端可达性模型（详见 AGENTS.md）。
