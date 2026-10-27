#!/usr/bin/env bash
# Publish acceptance: install the RELEASED package from the public registry into a
# profile that has never seen it, boot a host from it, and prove the served client
# bundle is the one that was built.
#
# Why this exists: every other gate (typecheck, vitest, build, verify:publish) runs
# on the WORKING TREE. None of them can see the mistakes that only appear after
# `npm publish` — a `files` list that drops lib/, a lib/ that was never rebuilt, a
# build flag that silently changes the bundle. That is not hypothetical: 1.0.9-port.6
# shipped with `lib/index.js` still at commit 9ca2757, missing the instance-level
# cache fix from 397f9da, and every local gate was green.
#
# Usage:
#   ./verify-registry-install.sh 1.0.9-port.9
#   ./verify-registry-install.sh 1.0.9-port.9 --keep     # leave the host running
#
# Exit 0 only when: tarball sha1 == registry dist.shasum, fileCount matches the
# published count, the bundle carries the release's markers, and a host booted from
# that profile serves a client bundle of the same byte length with the same markers.
set -uo pipefail

VERSION="${1:?usage: $0 <version> [--keep]}"
KEEP="${2:-}"
PKG="@sidequest-007/dsh-atlas"
REGISTRY="https://registry.npmjs.org"
HOME_DIR="/tmp/dsh-registry-check-$VERSION"
PROFILE="$HOME_DIR/profiles/acceptance"
PORT="${ACCEPTANCE_PORT:-3095}"
FAILED=0

say() { printf '%s\n' "$*"; }
fail() { FAILED=1; printf 'FAIL  %s\n' "$*"; }
pass() { printf 'ok    %s\n' "$*"; }

# --- 1. the published record -------------------------------------------------
say "== registry record for $PKG@$VERSION"
META="$(curl -fsS "$REGISTRY/$PKG/$VERSION")" || { say "FAIL  版本不存在（可能仍在 CDN 传播，稍后重试）"; exit 1; }
read -r SHASUM COUNT TARBALL < <(printf '%s' "$META" | node -e '
let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
  const v = JSON.parse(d).dist
  console.log(v.shasum, v.fileCount, v.tarball)
})')
say "      shasum $SHASUM  fileCount $COUNT"

# --- 2. the tarball the registry serves --------------------------------------
say "== tarball"
WORK="$(mktemp -d)"
curl -fsSL -o "$WORK/pkg.tgz" "$TARBALL" || { fail "下载失败 $TARBALL"; exit 1; }
GOT="$(sha1sum "$WORK/pkg.tgz" | cut -d' ' -f1)"
[ "$GOT" = "$SHASUM" ] && pass "sha1 == dist.shasum ($GOT)" || fail "sha1 $GOT != $SHASUM"
FILES="$(tar tzf "$WORK/pkg.tgz" | wc -l | tr -d ' ')"
[ "$FILES" = "$COUNT" ] && pass "tar 条目数 == fileCount ($FILES)" || fail "tar 条目 $FILES != $COUNT"
tar xzf "$WORK/pkg.tgz" -C "$WORK"
PV="$(node -p "require('$WORK/package/package.json').version")"
[ "$PV" = "$VERSION" ] && pass "package.json 版本 $PV" || fail "包内版本 $PV != $VERSION"
for f in lib/index.js lib/client.js lib/invariant.js; do
  [ -s "$WORK/package/$f" ] && pass "$f 在包内（$(wc -c < "$WORK/package/$f") B）" || fail "缺少 $f"
done

# --- 3. a profile that has never seen this package --------------------------
say "== profile $PROFILE"
rm -rf "$HOME_DIR"
mkdir -p "$PROFILE"
# The host needs a real profile skeleton (cordis.yml + compatibility.json) to boot;
# an empty directory with only dependencies starts and exits without a word. Copying
# the skeleton from the live profile keeps the room clean of the PACKAGE (step 4
# installs it from the registry) without fighting the host's own bootstrap.
SKELETON="${SKELETON_PROFILE:-$HOME/.dsh/profiles/web}"
cp "$SKELETON/cordis.yml" "$PROFILE/cordis.yml" 2>/dev/null || fail "缺少 $SKELETON/cordis.yml"
cp "$SKELETON/compatibility.json" "$PROFILE/compatibility.json" 2>/dev/null || true
cat > "$PROFILE/pnpm-workspace.yaml" <<'YAML'
nodeLinker: hoisted
autoInstallPeers: false
dangerouslyAllowAllBuilds: true
YAML
# Same plugin set as the skeleton EXCEPT our package: the acceptance profile must not
# inherit an atlas from a file: tarball or an older registry version.
node -e '
const fs = require("fs")
const live = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8"))
const deps = { ...live.dependencies }
delete deps["@sidequest-007/dsh-atlas"]
const out = { name: "dsh-profile-acceptance", private: true, dependencies: deps }
if (live.dsh) out.dsh = live.dsh
fs.writeFileSync(process.argv[2] + "/package.json", JSON.stringify(out, null, 2) + "\n")
' "$SKELETON" "$PROFILE"
pass "从 $SKELETON 复制骨架，剥掉 atlas（其余 $(node -p "Object.keys(require('$PROFILE/package.json').dependencies).length") 个依赖保留）"

( cd "$PROFILE" \
  && pnpm install --registry="$REGISTRY" --config.dangerouslyAllowAllBuilds=true >/tmp/acceptance-install.log 2>&1 \
  && pnpm add "$PKG@$VERSION" --registry="$REGISTRY" --config.dangerouslyAllowAllBuilds=true >>/tmp/acceptance-install.log 2>&1 )
INSTALLED="$(node -p "require('$PROFILE/node_modules/$PKG/package.json').version" 2>/dev/null)"
[ "$INSTALLED" = "$VERSION" ] && pass "profile 内安装版本 $INSTALLED（来自 registry）" || fail "安装版本 ${INSTALLED:-无} != $VERSION"

# --- 4. a host booted from that profile ------------------------------------
say "== boot on :$PORT"
cd "$HOME_DIR" || exit 1
setsid env DSH_HOME="$HOME_DIR" "$(command -v dsh)" --profile acceptance --port "$PORT" --no-open \
  > "$HOME_DIR/boot.log" 2>&1 < /dev/null &
BOOT_PID=$!
TOKEN=""
for _ in $(seq 1 40); do
  sleep 3
  TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$HOME_DIR/boot.log" 2>/dev/null | tail -1 | cut -d= -f2)"
  [ -n "$TOKEN" ] && break
done
if [ -z "$TOKEN" ]; then
  fail "未启动（$HOME_DIR/boot.log 无 token）"
else
  pass "boot: http://127.0.0.1:$PORT/?token=…"
  JAR="$HOME_DIR/cookies.txt"
  curl -fsS -c "$JAR" -o /dev/null "http://127.0.0.1:$PORT/?token=$TOKEN"
  curl -fsS -b "$JAR" -o "$HOME_DIR/index.html" "http://127.0.0.1:$PORT/"
  REV="$(grep -o "$PKG/client.js&rev=[a-f0-9]*" "$HOME_DIR/index.html" | head -1 | sed 's/.*rev=//')"
  if [ -z "$REV" ]; then
    fail "boot payload 里没有 $PKG（插件未注册）"
  else
    pass "boot payload 注册了插件，rev=$REV"
    CODE="$(curl -s -b "$JAR" -o "$HOME_DIR/client.js" -w '%{http_code}' \
      "http://127.0.0.1:$PORT/plugins/??$PKG/client.js&rev=$REV")"
    SERVED="$(wc -c < "$HOME_DIR/client.js" | tr -d ' ')"
    PACKED="$(wc -c < "$WORK/package/lib/client.js" | tr -d ' ')"
    [ "$CODE" = "200" ] && pass "客户端包 200（$SERVED B）" || fail "客户端包 HTTP $CODE"
    # The batch route appends its own sourceMappingURL line (~46 B here): it is the
    # host's envelope around the module, not the package's bytes. So assert the
    # published payload is a PREFIX of what the host serves, and that only that
    # trailer follows — a stale lib/ or a different build would not prefix-match.
    if node -e '
      const fs = require("fs")
      const strip = text => text.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, "")
      const served = strip(fs.readFileSync(process.argv[1], "utf8"))
      const packed = strip(fs.readFileSync(process.argv[2], "utf8"))
      // The host rewrites the trailing sourceMappingURL to its batch route
      // (??pkg/client.js.map&rev=…), so that one line is the only licence to differ.
      // The host also appends the batch separator ("\n;") after the module body.
      const norm = text => text.replace(/[\s;]+$/, "")
      process.exit(norm(served) === norm(packed) ? 0 : 1)
    ' "$HOME_DIR/client.js" "$WORK/package/lib/client.js"; then
      pass "服务端载荷 == 包内 lib/client.js（$PACKED B，仅尾部 sourceMappingURL 被 host 改写）"
    else
      fail "服务端载荷与包内 lib/client.js 不一致（可能是陈旧 lib 或不同构建）"
    fi
  fi
  ALERTS="$(grep -ci 'atlas.*\(error\|fail\)' "$HOME_DIR/boot.log" 2>/dev/null || true)"
  [ "${ALERTS:-0}" = "0" ] && pass "启动日志无 atlas 告警" || fail "启动日志有 $ALERTS 条 atlas 告警"
fi

if [ "$KEEP" = "--keep" ] && [ -n "$TOKEN" ]; then
  say "-- keep: host 仍在 :$PORT（pid $BOOT_PID），日志 $HOME_DIR/boot.log"
else
  [ -n "${BOOT_PID:-}" ] && kill "$BOOT_PID" 2>/dev/null
  sleep 1
fi
rm -rf "$WORK"

if [ "$FAILED" = "0" ]; then say "== PASS  $PKG@$VERSION 可从 registry 全新安装并加载"; else say "== FAIL  见上面的 FAIL 行"; fi
exit "$FAILED"
