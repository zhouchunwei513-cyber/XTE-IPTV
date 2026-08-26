# XTE-IPTV

> 飞牛 NAS（fnOS）上的 IPTV 直播源统一管理与智能代理。标准 HLS 输出，**无转码、零第三方依赖**，手机 / 平板 / 电视 / 电脑全终端直接看。

[![version](https://img.shields.io/badge/version-5.0-blue)]() [![license](https://img.shields.io/badge/license-MIT-green)]() [![runtime](https://img.shields.io/badge/runtime-Node.js-orange)]()

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

1. 下载最新版 `xte-5.0.fpk`（见 [Releases](../../releases)）。
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
