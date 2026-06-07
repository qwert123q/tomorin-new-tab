# Tomorin New Tab

[English](README.md) | 简体中文

Tomorin New Tab 是一个轻量、本地优先的 Chrome 新标签页扩展，灵感来自 Infinity New Tab。

## 功能

- 替换 Chrome 新标签页。
- 通过 `chrome.search` API 使用 Chrome 默认搜索引擎。
- 输入网址时直接打开网址。
- 分页展示常用网站收藏。
- 内置一组少量常用网站。
- 可在页面内添加、编辑、删除、调整大小、拖拽排序收藏网站。
- 支持右键收藏网站直接编辑。
- 支持全局图标密度：小 / 中 / 大。
- 右下角控制区默认收起到一个透明齿轮，悬停或聚焦时展开。
- 支持导入 Infinity New Tab 备份 JSON 中的网站收藏。
- 自动使用高清 favicon 候选链展示网站图标。
- 编辑收藏时展示可选图标候选。
- 当自动解析不理想时，支持为单个网站上传自定义图标。
- 会读取网页或 manifest 声明的图标、品牌图，尽量提供更清晰的候选。
- 保存后的图标会缓存到本地 IndexedDB，后续从本地副本渲染。
- 会自动缓存已经成功显示的图标，减少后续新标签页打开时的网络请求。
- 上传的壁纸会尽量保持清晰，避免显示模糊，并保留接近 4K 的分辨率。
- 收藏网站数据保存在 `chrome.storage.local`。
- 上传壁纸和已保存图标保存在 IndexedDB。
- 不需要账号，不使用服务器、云同步或壁纸 API。

## 本地安装

1. 打开 `chrome://extensions`。
2. 开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择仓库里的 `extension/` 文件夹。
5. 打开一个新标签页。

## 打包

生成可分发的 zip 包：

```bash
./scripts/package-extension.sh
```

zip 文件会输出到 `dist/`。发布和 Chrome Web Store 注意事项见 [docs/release.md](docs/release.md)。

## 本地数据

收藏网站元数据保存在 Chrome 扩展本地存储中。上传壁纸和保存后的图标保存在扩展自己的 IndexedDB 数据库中。这些数据都只属于当前 Chrome 用户资料；卸载扩展后会被移除。

更多隐私说明见 [PRIVACY.md](PRIVACY.md)。

## 许可证

MIT。见 [LICENSE](LICENSE)。
