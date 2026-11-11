# XTE-IPTV

> 飞牛 NAS（fnOS）上的 IPTV 直播源统一管理与智能代理。标准 HLS 输出，**无转码、零第三方依赖**，手机 / 平板 / 电视 / 电脑全终端直接看。

[![version](https://img.shields.io/badge/version-5.2.1-blue)]() [![license](https://img.shields.io/badge/license-MIT-green)]() [![runtime](https://img.shields.io/badge/runtime-Node.js-orange)]()

## v5.2.1 更新（重点：修复「导入源后电视直播看不了」）

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 所有频道在电视/盒子上都播不了 | 代理分片地址是 `/proxy/ts?sid=..&url=..`，**路径没有扩展名**；ffmpeg 系解码器（电视盒子、Kodi、mpv、TiviMate 等）在 HLS 解析阶段直接拒绝：`URL ... is not in allowed_segment_extensions` | 分片/子清单/密钥地址统一改为 `/proxy/ts/<sid>.ts`、`/proxy/m3u8/<sid>.m3u8`、`<sid>.key`，扩展名合规；路由同时兼容旧地址 |
| 2 | 播放列表里的地址是 `172.17.0.1`，电视连不上 | 内网地址探测取「最后一个私网 IPv4」，在装了 Docker 的飞牛上拿到的是 `docker0` 网桥 | 优先取**默认路由网卡**的地址，跳过 `docker0/br-*/veth/tailscale` 等虚拟网卡；未填 host 时优先用**播放器实际连上的 Host**（含 `x-forwarded-host`）；支持 `XTE_LAN_IP` 手工指定 |
| 3 | 死频道点开就报错/一直转圈 | 源站返回错误页/「需登录」文本时，旧版把它当 m3u8 继续改写成垃圾清单 | 校验上游必须含 `#EXT-X-TARGETDURATION`/`#EXT-X-STREAM-INF` 等必备标签，否则回 `502` + 可读原因；已有可用索引时保留旧索引，不写坏数据 |
| 4 | 公告/回看等 mp4、flv 频道播不了 | 非 HLS 内容被当播放列表解析 | 渐进式媒体改走直链透传（`/proxy/ts/<id>.mp4`，保留 Range，可拖动） |
| 5 | 多码率源「有画面没声音」/黑屏 | 主清单里的音轨 `#EXT-X-MEDIA` URI 没改写，播放器去 XTE 上 404 | `#EXT-X-MEDIA`/`#EXT-X-I-FRAME-STREAM-INF`/`#EXT-X-SESSION-KEY` 的 `URI=` 也统一改写 |
| 6 | 按频道 ID 聚合的源（iFansClub/咪咕中继）播不了 | 上游把 `01.m3u8` 当「频道目录下的文件」，RFC 解析到根路径后返回「地址格式错误」 | 基地址末段是纯数字频道 ID 时按目录解析 |
| 7 | 加了源却「0 个频道」，只看到 `read ECONNRESET` | 源站（如 `raw.githubusercontent.com`）在当前网络被阻断；IPv6 路由不通 | 错误翻译成可执行提示（改用本地上传/文本粘贴、或配代理）；回源遇到连接重置/超时自动改用 IPv4 重试一次 |
| 8 | 台名带逗号 / 用 `#EXTGRP` 的源解析错乱 | `#EXTINF` 用 `lastIndexOf(',')` 切标题 | 改为「引号外最后一个逗号」；支持 `#EXTGRP:` 分组与 BOM |

**新增功能：频道可用性检测** — 频道管理页「检测可用性」按钮，后台并发探测每个频道（取播放列表 + 试拉首个分片），完成后可一键停用不可用频道（实测 117 个 CCTV 频道 14 秒完成，100 可用 / 17 不可用）。

## 它能解决什么

- **直播源又多又乱**：远程订阅、本地 m3u、文本粘贴，三种方式一键导入，台标 / 名称 / 分组 / TVG-ID 可视化编辑，批量启停、分组、删除。
- **跨运营商 / 跨省卡顿**：移动源用电信宽带看、A 省源在 B 省看经常转圈——内置智能缓冲内核，分片预取、失败重试、坏片自动跳过，弱网与跨网环境下持续流畅。
- **多终端不好使**：内网 / IPv6 / FRP 三线路自动适配，手机在外用 FRP、电视在家走内网，分片地址自动指向「播放器连得上的那一个 Host」，所有终端都能播。
- **源没法整理导出**：编辑后的频道可一键导出标准 M3U，支持仅导出选中、当前列表或全部，可选内网代理地址 / 三线路合并 / 原始流地址，方便备份、迁移、分享。

## 功能特性

- 📺 **统一智能缓冲**：所有播放走一条代理链路，分片本地缓存 + 后台预取 + 失败重试，弱网不卡。
- 🔀 **三线路自动适配**：内网（LAN）/ IPv6 / FRP 公网，按播放器接入 Host 自动选择，终端零配置。
- 🛡️ **稳定性保护**：分片回源 30s 静默超时、坏片自动 `EXT-X-DISCONTINUITY` 跳过、假活会话 60s 自动重连、全局回源并发限流防出口打爆。
- 📝 **可视化源管理**：台标预览、分组管理、搜索筛选、批量操作、频道导出 M3U。
- 🧩 **即装即用**：fpk 应用包，fnOS 应用中心手动安装即可，无需 Docker、无需数据库。
- ⚡ **极致轻量**：原生 Node.js `http` 模块，零运行时依赖，内存占用低。

## 安装

### 飞牛 fnOS

1. 下载最新版 `xte-5.2.1-x86_64.fpk`（x86_64 NAS）或 `xte-5.2.1-aarch64.fpk`（ARM NAS），见 [Releases](../../releases)，仓库 `dist/` 目录里也有同名文件。
2. 打开 fnOS「应用中心」→ 右上角「手动安装」→ 选择 fpk 文件。
3. 安装完成后打开 XTE，在「源管理」里添加你的 IPTV 订阅地址或上传 m3u 文件。
4. 把播放地址（`http://<NAS内网IP>:34500/m3u/inner.m3u8`）填进任意支持 HLS 的播放器即可观看。

> 💡 **多终端建议**：飞牛影视 / 播放器里请填写 NAS 的**内网地址**（如 `http://192.168.x.x:34500/m3u/inner.m3u8`），避免部分终端走带宽有限的 FRP 链路导致卡顿。

### 本地运行（开发 / 调试）

```bash
git clone <your-repo-url> xte-iptv
cd xte-iptv
DEPLOY_RUN_PORT=34500 DATA_DIR=./data node app/server/main.js
```

管理界面：`http://localhost:34500`

## 播放地址

| 线路 | 地址 | 适用 |
|------|------|------|
| 内网 | `http://<NAS_IP>:34500/m3u/inner.m3u8` | 家庭内网设备（推荐） |
| IPv6 | `http://<NAS_IPv6>:34500/m3u/ipv6.m3u8` | 有 IPv6 的外网设备 |
| FRP | `http://<FRP域名>:34500/m3u/frp.m3u8` | 无 IPv6 的外网设备 |

兼容所有标准 HLS 播放器：VLC、PotPlayer、mpv、IINA、TVBox、IPTV Pro、TiviMate、飞牛影视等。

## 自行打包（飞牛官方 fnpack）

```bash
# 需要 fnOS 官方打包工具 fnpack（fnOS 应用开发工具，v1.2.x）
./build-fpk.sh          # 产物：dist/xte-<版本>-x86_64.fpk 与 dist/xte-<版本>-aarch64.fpk
```

脚本用官方 `fnpack build` 生成 `app.tgz + manifest(含 checksum) + cmd + config + wizard` 的标准 FPK（gzip USTAR tar），
纯 JS 应用两架构内容相同，仅 `manifest` 的 `platform` 不同。

## 项目结构

```
app/server/main.js     # 全部后端：智能缓冲内核 / 会话缓存 / 预取容错 / API / 静态服务
app/www/index.html     # 管理界面（仪表盘 / 源管理 / 频道 / 设置 / 日志）
app/ui/                # 桌面快捷方式图标
manifest               # FPK 元信息
cmd/                   # fnOS 生命周期脚本
config/                # 权限 / 资源配置
```

## 技术栈

- **运行时**：Node.js（fnOS 内置 nodejs_v18+）
- **后端**：原生 `http` / `https`，零第三方依赖
- **前端**：原生 HTML / CSS / JS 单页
- **输出**：标准 HLS（m3u8 + MPEG-TS），无转码

## 许可证

MIT
