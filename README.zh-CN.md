# GitHub Star Show Unlisted

[English](README.md) | 简体中文

> 一款 Chrome 扩展，用于在 GitHub 个人主页的 Star 页面筛选**未归类**的
> 仓库 —— 只显示没有加入任何 GitHub Star List 的 Star 仓库。

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![GPT-5.5](https://img.shields.io/badge/GPT-5.5-6686ff)
![GLM-5.2](https://img.shields.io/badge/GLM-5.2-black)

GitHub 允许你将 Star 仓库整理到 **Star List**（星标列表）中，但没有内置功能
可以查看哪些 Star 仓库*尚未*加入任何列表。本扩展在每个 GitHub 个人主页的
Star 页面添加一个 **Unlisted** 按钮，正是为了解决这个问题 —— 它会将所有
Star 仓库与每个列表（包括私有列表）进行交叉比对，只显示未归类的仓库，
并在本地分页展示。

## 功能特性

- **未归类筛选** —— 一键隐藏所有已加入列表的 Star 仓库，只留下尚未整理的。
- **列表归属胶囊标签** —— 每个未归类的 Star 卡片会显示彩色胶囊标签，
  标明它已加入的列表，一目了然。
- **从卡片直接加入列表** —— 筛选结果中的 Star 卡片列表下拉菜单可正常使用。
  将仓库加入列表后，胶囊标签会立即出现。
- **快速并行加载** —— 列表页面和 Star 页面通过共享连接池并发抓取，
  拥有数百个 Star 的个人主页也能在极短时间内加载完成。
- **实时进度** —— 加载列表和 Star 数据时显示旋转动画和页面计数器，
  实时展示进度。
- **本地分页** —— 未归类结果在客户端分页，提供上一页 / 下一页控件，
  无需额外的网络请求。
- **支持私有列表** —— 通过你已登录的浏览器会话读取列表，
  因此私有列表也会纳入比对。
- **优雅的错误处理** —— 如果 GitHub 的页面结构变化或请求失败，
  扩展会显示错误信息并保留所有 Star 仓库可见。

## 安装

### 从源码安装（开发者模式）

1. 打开 `chrome://extensions`。
2. 开启右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择本项目目录。

**Unlisted** 按钮会出现在任意 GitHub 个人主页 Star 页面的工具栏上，
例如 `https://github.com/<用户名>?tab=stars`。

## 工作原理

1. 点击 **Unlisted** 后，扩展通过你当前的浏览器会话，从 GitHub 列表页面
   读取已登录账号的 Star Lists。
2. 同时并行抓取你正在浏览的个人主页的所有 Star 仓库页面。
3. 将两组数据进行交叉比对，只保留未加入任何列表的仓库。
4. 未归类仓库以本地分页方式渲染，每张卡片会显示其所属列表的胶囊标签
  （如果在本次会话中添加过）。

GitHub 没有提供 Star Lists 的公开 API，因此扩展直接读取现有的 GitHub
列表页面。你必须登录 GitHub 才能进行列表检测。

## 项目结构

```
.
├── manifest.json   # Chrome 扩展清单文件 (MV3)
├── content.js      # 内容脚本：筛选、下拉菜单、胶囊标签
├── styles.css      # 扩展样式（胶囊标签、旋转动画、分页）
├── tests/
 │   └── smoke.cjs  # Playwright 冒烟测试，针对真实个人主页
└── README.md
```

## 开发

### 运行冒烟测试

冒烟测试使用 [Playwright](https://playwright.dev) 将扩展加载到无头
Chromium 中，并对真实的 GitHub 个人主页进行端到端流程验证。

```bash
npm install playwright
node tests/smoke.cjs
```

> 测试会访问真实的公开 GitHub 个人主页，需要网络访问权限。
> 测试会注入一个模拟的 `user-login` meta 标签，使扩展将会话视为已登录状态。

## 限制

- 扩展依赖 GitHub 当前的 DOM 结构。如果 GitHub 更改了 Star 卡片或列表页面
  的结构，扩展可能需要更新。
- Star 和列表页面通过浏览器会话抓取，因此速率限制和私有列表的可见性
  取决于当前登录的账号。
- 会话内的列表添加操作保存在内存中；离开页面或刷新后会从 GitHub 重新索引。

## 许可证

MIT —— 详见 [LICENSE](LICENSE)。
