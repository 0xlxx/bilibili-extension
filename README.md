# Bilibili 评论增强 - IP 属地 & 粉丝数

一个油猴（UserScript）脚本，在 B 站评论区为每条评论显示 **IP 属地** 和 **粉丝数量**，支持独立开关与深浅色主题自适应。

## 功能

- **IP 属地**：显示评论者 IP 属地（从评论组件内部数据提取）
- **粉丝数量**：通过 B 站公开接口实时获取，按量级分级配色
  - 格式：`128粉丝` / `1.2k粉丝` / `1.2w粉丝`
  - 配色：蓝灰 → 中蓝 → 琥珀 → 珊瑚红 → 金
- **评论收藏**：每条评论操作栏新增收藏按钮，收藏数据**无感保存**到浏览器本地（IndexedDB），支持取消收藏、按评论 ID 去重；还可一键**导出**为 JSON 文件到本地
- **独立开关**：右下角浮动设置按钮，可分别开启/关闭 IP 属地 / 粉丝数量 / 评论收藏，设置持久化到 `localStorage`
- **页面覆盖**：视频页 `/video/`、个人空间 `/space/`、动态页 `t.bilibili.com`、`/opus/`、稍后再看 `/list/watchlater`
- **主题自适应**：深色 / 浅色切换时自动重染颜色
- **性能优化**：粉丝数 10 分钟缓存，并发请求去重

## 安装

1. 安装油猴插件（Tampermonkey / Violentmonkey）
2. 将 `bilibili-ips.user.js` 导入为新建脚本（或安装 `.user.js` 直链）
3. 打开任意 B 站视频 / 空间 / 动态页面即可看到效果

## 技术要点

- 纯前端，`@grant none`，`document-end` 注入
- 深度遍历 B 站评论区 Shadow DOM，使用 `MutationObserver` 监听动态加载
- 通过 CSS 自定义属性穿透 Shadow DOM 控制 badge 显隐，`inline style` 绕过样式隔离
- 收藏数据存入 IndexedDB（keyPath=id），点击即无感保存，不打断浏览；导出优先用 File System Access API 弹窗保存，不支持时降级为浏览器下载
- 模块化组织：配置、数据提取、API 缓存、格式化、样式注入、渲染、评论收藏、设置面板、入口编排

## License

MIT
