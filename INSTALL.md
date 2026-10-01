# 安装说明（给别人看的）

这是一份**可分享的副本**：解压后照下面做就能装上。全程不需要原作者的那台机器。

> 只是想自己用？看 [MANUAL.md](MANUAL.md)。想改代码？看 [AGENTS.md](AGENTS.md)。

## 你需要什么

| 条件 | 说明 |
|---|---|
| **DSH** | 实测于 `0.1.5-rc.2` 的 web profile。更新的版本多半也行，但没实测过 |
| **Node.js** | `^22.19.0` 或 `>=24`（DSH 自己就要求这个，通常已经有） |
| 浏览器 | Chromium 内核（Chrome / Edge）。Firefox 没测过 |

## 安装：两条路，选一条

### 路 A：官方命令（推荐）

```sh
dsh plugin --profile web add <解压出来的目录>
```

这条路会让 pnpm 把依赖也装好，**装完重启一次 DSH**。

### 路 B：不重启（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

它自己找 DSH 的安装位置（先看环境变量 `DSH_HOME`，再找 `%USERPROFILE%\.dsh`），
在 profile 里建一个目录链接、追加一行配置，并**顺手把设置卡片需要的依赖链上**
（DSH 自带那份）。不碰 `package.json`，不跑 pnpm。

- 找不到 profile 会**明确报错并列出有哪些 profile**，不会乱写
- 装之前**自动备份** `cordis.patch.yml`
- 大多数 profile 会热加载（几秒内生效）；不热加载的，脚本会提醒你手动重启
- **撤销**：`powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1`

## 装完检查

1. **重启（或等几秒）后刷新浏览器**
2. 看到深海底背景 + 一条短片铺满窗口 → 装好了
3. **设置 → 插件 →「插件配置」**，找到写着「启动动画」的那一行（默认是收起的），点开：
   - 能看到「淡入时长 / 进入方式 / 素材池」三节 → 完全正常
   - **看不到这一行** → 设置卡片没注册上。最常见原因是上面那个依赖没链上，
     在包目录里跑一次 `npm install --omit=dev`，再跑一遍 `install.ps1`

## 换掉自带的片子

包里三段 mp4 是作者自己的动画，**随 MIT 一起给你**，你可以直接换：

1. 把你的视频丢进 `assets/videos/`（只认 `.mp4` `.webm` `.m4v` `.mov`；推荐 H.264 + AAC 的 mp4）
2. 打开设置卡片看素材池那一行——有黄色 **`未优化`** 徽章的话，双击
   `tools\apply-faststart.bat` 处理一下（原片自动备份到 `assets\videos\originals\`）
3. 刷新页面

不想留作者的片子，直接把那三个 `.mp4` 删掉再放自己的即可（池子空了也不会卡住，只是没有画面）。

## 卸掉

| 想要 | 怎么做 |
|---|---|
| 暂时不要动画 | 设置卡片里关掉「开启启动动画」 |
| 摘掉插件（留文件） | `powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1`，然后重启 |
| 彻底删掉 | 先跑上面的 uninstall，再删掉整个目录 |

## 这份副本里没有什么

- **没有** `node_modules/`（依赖要现装）
- **没有** `assets/videos/originals/`（作者重排前的原片备份，对使用者无用）
- **没有**开发用的自检套件与安装脚本（`tools/verify-*`、`apply-boot-animation.ps1` 等）。
  那些绑定在作者的开发机上（要指向 DSH 源码 checkout），发出来只会让你困惑。
  要改代码看 [AGENTS.md](AGENTS.md)
- README.md 是作者的完整开发记录，里面会提到上面那些没随包发出来的脚本——那是历史记录，不是使用说明

## 许可

MIT，见 [LICENSE](LICENSE)。改、用、再分发都可以，保留版权声明即可。
