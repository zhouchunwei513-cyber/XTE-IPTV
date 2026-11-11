#!/bin/bash
# 用飞牛官方 fnpack 打包 FPK（x86_64 + aarch64 双架构）
#   前置：安装 fnOS 官方打包工具 fnpack（本机路径 /usr/local/bin/fnpack，版本 1.2.x）
#   产物：dist/xte-<version>-x86_64.fpk、dist/xte-<version>-aarch64.fpk
#   纯 JS 应用无原生二进制，两架构的 app.tgz 完全相同，仅 manifest 的 platform 不同。
set -euo pipefail
cd "$(dirname "$0")"

FNPACK="${FNPACK_BIN:-$(command -v fnpack || true)}"
if [ -z "${FNPACK}" ] || [ ! -x "${FNPACK}" ]; then
  if [ -x /usr/local/bin/fnpack ]; then FNPACK=/usr/local/bin/fnpack; else
    echo "错误：未找到飞牛官方打包工具 fnpack（可用 FNPACK_BIN=/path/to/fnpack 指定）" >&2
    exit 1
  fi
fi

VERSION="$(awk -F'=' '/^version/{gsub(/ /,"",$2);print $2}' manifest)"
[ -n "${VERSION}" ] || { echo "错误：manifest 缺少 version" >&2; exit 1; }

# 语法自检，避免把错误代码打进包
node --check app/server/main.js
for f in config/privilege config/resource; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))"; done

rm -rf build
mkdir -p dist

build_arch() {
  local platform="$1" suffix="$2" stage="build/$1"
  mkdir -p "${stage}/wizard"
  cp -r app cmd config ICON.PNG ICON_256.PNG manifest "${stage}/"
  sed -i "s/^platform .*/platform              = ${platform}/" "${stage}/manifest"
  chmod +x "${stage}/cmd/"*
  ( cd "${stage}" && "${FNPACK}" build -d . >/dev/null )
  local out="dist/xte-${VERSION}-${suffix}.fpk"
  mv "${stage}/${APPNAME:-xte}.fpk" "${out}"
  echo "built: ${out} ($(du -h "${out}" | cut -f1))"
}

build_arch x86 x86_64
build_arch arm aarch64

rm -rf build
echo
echo "全部产物："
ls -l dist/*.fpk
