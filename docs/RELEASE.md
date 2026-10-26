# 发布跑本（1.0.9-port.6）

这份文件是**给执行者看的**：把本仓库的构建物发到 GitHub 与 npm 的全部动作、每条命令的预期输出、以及失败时怎么退回去。
它不进入 npm 发布物（`files` 不含 `docs/`），也不影响运行时。

## 0. 发什么

| 项 | 值 |
|---|---|
| 包名 | `@sidequest-007/dsh-atlas` |
| 版本 | `1.0.9-port.6`（package.json 与 dsh.plugin.json 同步） |
| 访问级别 | `publishConfig.access = "public"` |
| 发布物 | 66 个文件：`lib/index.js` `lib/client.js` `lib/invariant.js` `lib/types/**` `assets/**` `cordis.patch.yml` `dsh.plugin.json` `README*.md` `CHANGELOG.md` `LICENSE*` `NOTICE` |
| 不入库/不入包 | `lib/*.map`（内联了绝对路径）、`coverage/`、`node_modules/`、`Eason/`、`AGENTS.md` |

## 1. 门禁（缺一不发布）

```bash
cd dsh-atlas
./node_modules/.bin/tsc --noEmit                      # 0 errors
./node_modules/.bin/vitest run                        # 41 files, 986 passed | 1 skipped
npm run build                                         # lib/index.js lib/client.js lib/invariant.js
npm run verify:publish                                # ok — 66 files, no internal artifacts, ad-free
```

`1 skipped` 是 `tests/runtime.spec.ts:262` 的 win32-only 分支，在 Linux 上按设计跳过——不是失败。

覆盖率（`vitest run --coverage`，v8，排除纯类型 `src/types.ts`）：

| 指标 | 当前 | 100%？ |
|---|---|---|
| Statements | 90.73% (4977/5485) | 否 |
| Branches | 86.09% (3344/3884) | 否 |
| Functions | 87.28% (961/1101) | 否 |
| Lines | 93.17% (4138/4441) | 否 |

未覆盖的主体是防御性回退分支与 UI 交互回执（`src/client/index.ts` 185 条、`src/client/source.ts` 67 条、`src/defaults.ts` 41 条），不是未测的主路径。

## 2. GitHub

```bash
git add -A && git commit -m "feat: … (1.0.9-port.6)"
git tag -f v1.0.9-port.6
git push origin main
git push origin v1.0.9-port.6
```

- 远端：`https://github.com/jameswatt139240-crypto/dsh-ATLAS.git`（`origin`，分支 `main`）
- 需要：对该仓库有 `push` 权限的凭据（PAT，`repo` scope 或细粒度 Contents: write）。
- 2026-10-27 本地已提交：`9ca2757` + tag `v1.0.9-port.6`，**push 尚未执行**（凭据待提供）。

## 3. npm

`1.0.9-port.6` 是**预发布版本**（semver 带 `-port.6`）。`npm publish` 默认 tag 是 `latest`，
而 npm 只允许预发布版本发到**非 latest** 的 tag，所以必须显式给 tag：

```bash
# 只发布，不动 latest（推荐）
npm publish --access public --tag port

# 想让插件安装默认就是这一版，才发 latest（会盖掉 1.0.9）
npm publish --access public --tag latest
```

- registry：当前 `~/.npmrc` 指向 `registry.npmmirror.com`（**只读镜像，不能发**），发布必须显式走官方源：
  ```bash
  npm publish --registry=https://registry.npmjs.org/ --access public --tag port
  ```
- 需要：`@sidequest-007` scope 的发布权限（Automation token 或带 2FA 的账号）。
- `prepublishOnly` 会再跑一遍 `pnpm run check`（typecheck + test + build + verify）——门禁在发布前自动重申一次。

## 4. 发完的验收

```bash
npm view @sidequest-007/dsh-atlas@1.0.9-port.6 version dist.tarball --registry=https://registry.npmjs.org/
dsh plugin --profile <隔离 profile> add @sidequest-007/dsh-atlas@1.0.9-port.6
curl -s "http://127.0.0.1:<port>/?token=<token>" | grep -o '@sidequest-007/dsh-atlas/client.js&rev=[a-z0-9]*'
```

验收判据：`npm view` 能查到版本与 tarball；隔离 profile 装得上且 boot payload 里出现 atlas 的
`client.js` rev；页面按 Esc 漫游时读数单位是**轮**（A-33 默认）。

## 5. 回滚

| 现场 | 动作 |
|---|---|
| npm 发错 tag | `npm dist-tag add @sidequest-007/dsh-atlas@1.0.9 latest --registry=https://registry.npmjs.org/` |
| npm 版本要撤 | `npm unpublish @sidequest-007/dsh-atlas@1.0.9-port.6 --registry=https://registry.npmjs.org/`（72 小时内可用） |
| GitHub 推错 | `git push --force-with-lease origin <上一个好提交>:main`，tag 用 `git push --delete origin v1.0.9-port.6` |
| 本机 profile 装坏 | `./install-into-live.sh --rollback <备份.tgz>`（脚本带 `.origin` 戳，拒绝跨 profile 回滚） |
