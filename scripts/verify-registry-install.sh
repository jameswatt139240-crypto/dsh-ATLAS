#!/usr/bin/env bash
# Publish acceptance: install the RELEASED package from the public registry into a
# profile that has never seen it, boot a host from it, and prove the client bundle the
# host serves is the one that was published.
#
# Why this exists: every other gate (tsc, vitest, build, verify:publish) runs on the
# WORKING TREE. None of them can see the mistakes that only exist after `npm publish`
# — a `files` list that drops lib/, a lib/ that was never rebuilt, a build flag that
# changed the bundle. That is not hypothetical: 1.0.9-port.6 shipped with
# lib/index.js still at commit 9ca2757, missing the instance-level cache fix from
# 397f9da, while every local gate was green.
#
# Usage:
#   ./verify-registry-install.sh 1.0.9-port.9
#   ./verify-registry-install.sh 1.0.9-port.9 --keep      # leave the host running
#   SKELETON_PROFILE=~/.dsh/profiles/web ./verify-registry-install.sh <version>
#
# Exit 0 only when the tarball matches the registry record, the profile installs the
# package THROUGH THE REGISTRY (never a file: tarball), a host boots from that profile
# and registers the plugin, and the bundle it serves equals the package's own
# lib/client.js up to the two edits the host makes to every module it serves.
set -uo pipefail

VERSION="${1:?usage: $0 <version> [--keep]}"
KEEP="${2:-}"
PKG="@sidequest-007/dsh-atlas"
REGISTRY="${REGISTRY:-https://registry.npmjs.org}"
HOME_DIR="${DSH_HOME:-/tmp/dsh-registry-check-$VERSION}"
PROFILE_NAME="${PROFILE_NAME:-acceptance}"
PROFILE="$HOME_DIR/profiles/$PROFILE_NAME"
PORT="${ACCEPTANCE_PORT:-3095}"
FAILED=0

say() { printf '%s\n' "$*"; }
fail() { FAILED=1; printf 'FAIL  %s\n' "$*"; }
pass() { printf 'ok    %s\n' "$*"; }

# --- 1. the published record (with propagation tolerance) --------------------
say "== registry record for $PKG@$VERSION"
META=""
for attempt in $(seq 1 30); do
  META="$(curl -fsS "$REGISTRY/$PKG/$VERSION" 2>/dev/null)" && [ -n "$META" ] && break
  META=""
  sleep 10
done
if [ -z "$META" ]; then
  say "FAIL  registry 上找不到 $VERSION（等了 5 分钟）"
  exit 1
fi
read -r SHASUM COUNT TARBALL < <(printf '%s' "$META" | node -e '
let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
  const v = JSON.parse(d).dist
  console.log(v.shasum, v.fileCount, v.tarball)
})')
say "      shasum $SHASUM  fileCount $COUNT"

# --- 2. the tarball the registry serves --------------------------------------
say "== tarball"
WORK="$(mktemp -d)"
curl -fsSL -o "$WORK/pkg.tgz" "$TARBALL" || { say "FAIL  下载失败 $TARBALL"; exit 1; }
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
mkdir -p "$HOME_DIR"
CLI="$(command -v dsh)"
[ -n "$CLI" ] || { say "FAIL  PATH 上没有 dsh"; exit 1; }

# Preferred: let the host scaffold its own profile from the shipped template — the
# same thing a user gets, and no copy of anybody's live profile is involved.
if DSH_HOME="$HOME_DIR" "$CLI" "$PROFILE_NAME" --from-default-profile web --dump-config \
     > "$HOME_DIR/scaffold.log" 2>&1 && [ -f "$PROFILE/package.json" ]; then
  pass "profile 由 host 的 web 模板创建（--from-default-profile）"
else
  # Fallback for a host too old to scaffold: copy a skeleton, then delete our package
  # from it so the only way in is the registry (step 4).
  SKELETON="${SKELETON_PROFILE:-$HOME/.dsh/profiles/web}"
  mkdir -p "$PROFILE"
  if [ -f "$SKELETON/package.json" ]; then
    cp "$SKELETON/cordis.yml" "$PROFILE/cordis.yml" 2>/dev/null || fail "缺少 $SKELETON/cordis.yml"
    cp "$SKELETON/compatibility.json" "$PROFILE/compatibility.json" 2>/dev/null || true
    node -e '
      const fs = require("fs")
      const live = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8"))
      const deps = { ...live.dependencies }
      delete deps["@sidequest-007/dsh-atlas"]
      const out = { name: "dsh-profile-acceptance", private: true, dependencies: deps }
      if (live.dsh) out.dsh = live.dsh
      fs.writeFileSync(process.argv[2] + "/package.json", JSON.stringify(out, null, 2) + "\n")
    ' "$SKELETON" "$PROFILE"
    pass "profile 由骨架 $SKELETON 创建，已剥掉 $PKG"
  else
    say "FAIL  既不能 --from-default-profile，也没有骨架可复制"
    exit 1
  fi
fi
if node -e '
  const p = require(process.argv[1] + "/package.json")
  process.exit(p.dependencies && p.dependencies["@sidequest-007/dsh-atlas"] ? 1 : 0)
' "$PROFILE"; then pass "profile 起始状态不含 $PKG"; else fail "profile 起始就有 $PKG，干净房间不成立"; fi

# The user's own install path, against the public registry.
# `npm_config_registry` is how pnpm (which the plugin manager drives) is pointed at the
# public registry: this machine's pnpm defaults to a mirror, and a mirror that has not
# caught up yet answers "connection timed out" for a version that was published
# seconds ago. The acceptance run must never depend on somebody else's cache.
if DSH_HOME="$HOME_DIR" npm_config_registry="$REGISTRY" \
     "$CLI" plugin --profile "$PROFILE_NAME" add "$PKG@$VERSION" --registry="$REGISTRY" \
     > "$HOME_DIR/install.log" 2>&1; then
  pass "dsh plugin add $PKG@$VERSION（来自 registry）"
else
  fail "dsh plugin add 失败，见 $HOME_DIR/install.log"
  tail -5 "$HOME_DIR/install.log" | sed 's/^/      /'
fi
INSTALLED="$(node -p "require('$PROFILE/node_modules/$PKG/package.json').version" 2>/dev/null)"
[ "$INSTALLED" = "$VERSION" ] && pass "profile 内安装版本 $INSTALLED" || fail "安装版本 ${INSTALLED:-无} != $VERSION"

# --- 4. a host booted from that profile ------------------------------------
say "== boot on :$PORT"
cd "$HOME_DIR" || exit 1
setsid env DSH_HOME="$HOME_DIR" "$CLI" --profile "$PROFILE_NAME" --port "$PORT" --no-open \
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
    # The host rewrites the trailing sourceMappingURL to its batch route
    # (??pkg/client.js.map&rev=…) and appends the batch separator ("\n;") after the
    # module body. Those two are the only licence to differ: a stale lib/ or another
    # build would not match on the body.
    if node -e '
      const fs = require("fs")
      const strip = text => text
        .replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, "")
        .replace(/[\s;]+$/, "")
      const served = strip(fs.readFileSync(process.argv[1], "utf8"))
      const packed = strip(fs.readFileSync(process.argv[2], "utf8"))
      process.exit(served === packed ? 0 : 1)
    ' "$HOME_DIR/client.js" "$WORK/package/lib/client.js"; then
      pass "服务端载荷 == 包内 lib/client.js（$PACKED B，仅尾部 sourceMappingURL 与分隔符不同）"
    else
      fail "服务端载荷与包内 lib/client.js 不一致（陈旧 lib 或不同构建）"
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

if [ "$FAILED" = "0" ]; then
  say "== PASS  $PKG@$VERSION 可从 registry 全新安装并加载"
else
  say "== FAIL  见上面的 FAIL 行"
fi
exit "$FAILED"
