# 发布手册（维护者自己看）

按顺序做，一遍就能发出去。命令都是 PowerShell，在仓库根目录跑。

---

## 0. 发布前必改的三处占位符

| 位置 | 占位符 | 改成 |
|---|---|---|
| `package.json` → `repository` / `homepage` / `bugs` | `xwxw773-debug` | 你的 GitHub 用户名 |
| `启动NapCat.bat` → `YOUR_QQ` | `YOUR_QQ` | **保持占位符，别填真号**（这是给群友改的模板） |
| `README.md` → 方式 B 的 clone 地址 | `xwxw773-debug` | 同上 |

顺手确认一遍没有漏网的隐私（真实 QQ 号、群号、`C:\Users\<你的用户名>`、旧的 `file:` 绝对路径）：

```powershell
# 把 <旧路径> <你的QQ> <你的群号> 换成实际值再查
rg -n "<旧路径>|<你的QQ>|<你的群号>|C:[\\/]Users" .
git status --short   # 不该出现 config.json / *.jsonl / _archive
```

---

## 1. 建仓库

**GitHub**：New repository → 名字 `dsh-shenlan-whale` → Public → **不要**勾 README/LICENSE/.gitignore（本地已经有了）。

**Gitee**：新建仓库 → 「导入已有仓库」→ 填 GitHub 地址。这样两边内容一致，以后一条命令双推。

---

## 2. 首次推送

```powershell
git init
git add .
git commit -m "feat: 深蓝鲸 0.40.0 首次开源"
git branch -M main

git remote add origin https://github.com/xwxw773-debug/W-x-x-W.git
git remote add gitee  https://gitee.com/xwxw773-debug/W-x-x-W.git

git push -u origin main
git push gitee main
```

以后日常双推：

```powershell
git push origin main; git push gitee main
```

## 3. 打标签 + Release（群友下载走这里）

```powershell
git tag -a v0.40.0 -m "深蓝鲸 0.40.0"
git push origin v0.40.0; git push gitee v0.40.0

# 打包给群友直接下载
Compress-Archive -Path index.js,lib,cordis.patch.yml,package.json,README.md,LICENSE,CHANGELOG.md,CONCEPTS.md,SCHEME.md,UX.md,启动NapCat.bat -DestinationPath dist\dsh-shenlan-whale-0.40.0.zip -Force
```

GitHub → Releases → Draft a new release → 选 tag `v0.40.0` → 把 zip 拖进去 → 写更新说明（直接抄 CHANGELOG 顶部）。
Gitee → 发行版 → 同样操作。

> **zip 里的目录结构很重要**：解压后应直接看到 `package.json` 和 `index.js`。
> 别打成一个套了一层的 `dsh-shenlan-whale/dsh-shenlan-whale/`，群友会填错 `file:` 路径。

## 4. 发到 QQ 群

1. 群文件上传 `dsh-shenlan-whale-0.40.0.zip`，文件名别改（版本号要能看出来）。
2. 用 [QQ群分享文案.md](QQ群分享文案.md) 里的公告发一条，**置顶**。
3. 群文件说明里贴 GitHub + Gitee 两个地址，写清「GitHub 打不开就用 Gitee」。

## 5. 可选：发 npm（最省事的安装方式）

```powershell
npm login
npm publish --access public
```

之后群友在插件管理器里直接填 `dsh-shenlan-whale` 就能装，不用下载解压。
发布前先确认名字没被占：`npm view dsh-shenlan-whale version`（404 就是可用）。

注意：`package.json` 里已经去掉了 `"private": true`；`files` 白名单只放运行时需要的东西。

---

## 发布检查清单

- [ ] `xwxw773-debug` 全部替换
- [ ] `npm test` 全绿
- [ ] `git status` 里没有 `config.json` / `*.jsonl` / `_archive` / `.snapshots`
- [ ] 仓库里有 README / LICENSE / CONTRIBUTING / CHANGELOG
- [ ] Release 附了 zip，且 zip 解压后第一层就是 `package.json`
- [ ] 群公告置顶，两个仓库地址都能打开
- [ ] 截图（可选）：面板、群聊对话各来一张，放 `docs/screenshots/` 并在 README 引用
