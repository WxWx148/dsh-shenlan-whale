# 参与开发

## 环境

- Windows 10/11 x64
- DSH 桌面版（插件跑在 profile 里，单独起不来）
- Node ≥ 22（DSH 自带；单独开发时装一个也行）
- NapCat（想在真机上验证 QQ 通道才需要）

```powershell
git clone https://github.com/WxWx148/W-x-x-W.git
cd dsh-shenlan-whale
npm test
```

## 必须知道的一个坑

profile 里的依赖是 `file:` 形式，**pnpm 对 `file:` 是复制不是软链**。
所以你改了源码，宿主加载的还是 `node_modules/dsh-shenlan-whale` 里的旧副本——重启多少次都没用。

```powershell
node scripts/sync-to-profile.mjs           # 同步过去
node scripts/sync-to-profile.mjs --check   # 只比对，不一致退出码 1
```

改源码 → 同步 → 重启 DSH。三步缺一不可。

## 三条硬规矩

这些不是风格偏好，是静态守卫会当场判红的：

1. **依赖只准向下。** `lib/qq/*` 不认识「回话」，`turn` 不认识传输层。
   断链、成环、越层、绕闸，四条由 `scripts/check-layers.mjs` 守。
2. **配置键必须两边对账。** `lib/config.mjs` 的 `DEFAULTS` 与 `lib/panel.mjs` 的可改项
   逐键一一对应，多一个少一个，测试当场红。加配置 = 两个文件一起改。
3. **文案是代码的一部分。** 面板上每个键的中文名、说明、风险等级都在 `panel.mjs` 里，
   不许在别处硬编码第二份（`npm run audit:config` 查有没有人绕过）。

另外：`npm test` 必须全绿再提 PR；`npm run check` 是它的子集，快一点。

## 提交

- 一个 PR 只做一件事。顺手重构请单独提。
- commit 说清「为什么改」，不是「改了什么」——diff 已经说明改了什么。
- 改动涉及配置键、数据格式、面板文案，请同步更新 `CHANGELOG.md`。
- 别提交 `config.json`、`*.jsonl`、`_archive/`、`.snapshots/`（`.gitignore` 已挡，但别手滑）。

## 报 bug

面板上有「复制诊断信息」，把那段贴进 issue，比描述十句都有用。
另外附上：DSH 版本、插件版本、NapCat 版本、复现步骤。

## 安全

发现可能泄露聊天记录、令牌、或能被陌生人远程利用的问题，先别开公开 issue，
在 issue 里只说「有安全问题，想要私下联系方式」，我们会找你。
