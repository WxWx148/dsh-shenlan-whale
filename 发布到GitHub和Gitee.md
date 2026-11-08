# 发到 GitHub + Gitee（照抄版）

> 面向这台机器：**没装 git**，GitHub/Gitee 都能连通，没有代理。
> 全程 PowerShell，命令一行一行复制。预计 20 分钟。

---

## 0. 两条路线，先选一条

| 路线 | 适合 | 代价 |
|---|---|---|
| **A. Git 命令行**（本文主推） | 以后还要改代码、持续更新 | 装 Git，学 5 条命令 |
| **B. 网页上传** | 只发一次，以后不打算维护 | 115 个文件要分批拖，且**没有版本历史** |

下面先讲 A，B 放在最后（第 9 节）。

---

## 1. 装 Git

```powershell
winget install --id Git.Git -e --source winget
```

装完**关掉这个窗口重开**（PATH 才会刷新），然后验证：

```powershell
git --version
```

看不到版本号就重启一次电脑，或者直接用全路径：

```powershell
& 'C:\Program Files\Git\cmd\git.exe' --version
```

配置身份（提交记录里显示的名字，不是账号密码）：

```powershell
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱@example.com"
# 中文文件名不显示成 \346\267\261 这种转义
git config --global core.quotepath false
# 让 Git 记住凭据，不用每次推都输 token
git config --global credential.helper manager
```

---

## 2. GitHub 建空仓库

1. 打开 https://github.com/new
2. Repository name：`dsh-shenlan-whale`
3. Public
4. **不要**勾 "Add a README file" / ".gitignore" / "license"——本地都有了，勾了会冲突
5. Create repository

记下你的用户名：`github.com/**<你的用户名>**/dsh-shenlan-whale`

---

## 3. 拿到 GitHub 的推送凭据（PAT）

GitHub 早就不让用密码推了，用 Personal Access Token：

1. https://github.com/settings/tokens → **Generate new token (classic)**
2. Note 随便写，Expiration 选 90 天
3. 勾 **`repo`**（整个大项）
4. Generate token → **立刻复制**（`ghp_` 开头，只显示一次）

推送时：
- 用户名：你的 GitHub 用户名
- 密码：**粘贴这个 token**（不是你的登录密码）

> 想改用 SSH 也行：`ssh-keygen -t ed25519 -C "你的邮箱"` → 把 `~/.ssh/id_ed25519.pub` 贴到
> https://github.com/settings/keys → 远程地址改成 `git@github.com:用户名/dsh-shenlan-whale.git`。

---

## 4. 本地初始化 + 第一次提交

```powershell
cd D:\dsh-shenlan-whale
git init
git add .
git status --short     # 先看一眼：不该出现 config.json / *.jsonl / dist / _archive
git commit -m "feat: 深蓝鲸 0.46.0 首次开源"
git branch -M main
```

`git status` 里如果看到 `dist/`、`sandbox/`、`config.json`，说明 `.gitignore` 没生效——
先确认文件名真的是 `.gitignore`（没有 `.txt` 后缀）。

---

## 5. 接两个远程，一次推两边

```powershell
git remote add origin https://github.com/<你的用户名>/dsh-shenlan-whale.git
git remote add gitee  https://gitee.com/<你的Gitee用户名>/dsh-shenlan-whale.git

git push -u origin main      # 第一次会问账号密码 → 密码填 token
git push gitee main
```

推完刷新网页，两边都该看到 115 个文件和 README 渲染。

---

## 6. Gitee 的两种打法

**打法一（推荐）：Gitee 导入 GitHub**
Gitee → 新建仓库 → 右上「**导入已有仓库**」→ 填 GitHub 地址 → 建好后自动同步一次。
优点：不用单独配 Gitee 凭据，以后 Gitee 那边点「强制同步」就行。

**打法二：真的双推**
Gitee 建空仓库（同样不勾初始化），然后按第 5 节 `git push gitee main`。
需要 Gitee 凭据：设置 → 私人令牌 → 生成，推送时用户名填 Gitee 用户名、密码填令牌。
另外 Gitee 建**公开**仓库通常要实名认证，没实名会卡在创建那一步。

> 两边都用的话，**打法二更省心**：一条命令推完两个地方，不用来回点「强制同步」。

---

## 7. 以后每次更新

```powershell
cd D:\dsh-shenlan-whale
git add .
git commit -m "fix: 说明改了什么"
git push origin main; git push gitee main
```

嫌长就存成别名：

```powershell
git config --global alias.both "!git push origin main && git push gitee main"
# 以后：git both
```

---

## 8. 打版本 + 发 Release（群友从这下载）

```powershell
git tag -a v0.46.0 -m "深蓝鲸 0.46.0"
git push origin v0.46.0; git push gitee v0.46.0
```

zip 已经在 `dist\dsh-shenlan-whale-0.46.0.zip`。想重新打：

```powershell
Compress-Archive -Path index.js,base,facts,truth,decide,turn,voice,mind,ability,life,view,channel,lib,cordis.patch.yml,package.json,README.md,ARCHITECTURE.md,CHANGELOG.md,LICENSE,启动NapCat.bat -DestinationPath dist\dsh-shenlan-whale-0.46.0.zip -Force
```

GitHub → Releases → Draft a new release → 选 `v0.46.0` → 拖入 zip → 发布。
Gitee → 发行版 → 新建 → 同样附 zip。

---

## 9. 常见报错

| 现象 | 原因 / 解法 |
|---|---|
| `Failed to connect to github.com port 443` | 网络被墙或抖动。先 `Test-NetConnection github.com -Port 443`；要代理就 `git config --global http.proxy http://127.0.0.1:7890`（端口换成你自己的），取消用 `--unset` |
| `Authentication failed` | 密码填的是登录密码。要用 token；token 过期了重新生成 |
| `remote origin already exists` | `git remote set-url origin <新地址>`，不用删了重加 |
| `rejected ... non-fast-forward` | 远端有你本地没有的提交（多半建仓时勾了 README）。`git pull --rebase origin main` 再推 |
| 中文文件名显示成 `\346\267\261` | `git config --global core.quotepath false` |
| `Host key verification failed` | 首次 SSH 连接，输入 `yes` 回车 |
| Gitee 创建公开仓库失败 | 没实名。去 Gitee 设置里实名（身份证），或先建私有仓库 |
| 推上去 `.bat` 换行坏了 | 仓库里已有 `.gitattributes` 强制 `*.bat` 用 CRLF，别删它 |

---

## 10. 网页上传（路线 B，应急用）

GitHub：仓库页 → **Add file → Upload files** → 把 `lib`、`tests` 等文件夹整个拖进去。
单次上限 100 个文件——115 个文件要分两次传（先传文件，再传文件夹）。
Gitee：新建仓库后同样有「上传」入口，限制更宽松。

**代价**：没有提交历史，以后想让群友拉更新只能重传，`git pull` 拿不到东西。
所以只建议「此生只发一次」的情况。

---

## 11. 发完自查

- [ ] `github.com/<你>/dsh-shenlan-whale` 能打开，README 正常显示中文
- [ ] `gitee.com/<你>/dsh-shenlan-whale` 内容一致
- [ ] 两边 `package.json` 里的 `WxWx148` 都已替换（否则首页链接点进去 404）
- [ ] Release 里有 `dsh-shenlan-whale-0.46.0.zip`
- [ ] 群文件里也放了一份 zip，公告置顶
- [ ] 自己用无痕窗口点一遍下载链接，确认不需要登录
