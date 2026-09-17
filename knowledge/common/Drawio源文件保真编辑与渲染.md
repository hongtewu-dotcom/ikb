---
retrieval: [{"objects":["Drawio","draw.io","Drawio源文件"],"intents":["保真方案","编辑设计","渲染评审","分组坐标设计","导出方案"]}]
id: drawio-source-preserving-edit-render
title: Drawio 源文件保真编辑与渲染
aliases: [draw.io XML, ElementTree, rsvg-convert, group坐标, fill transparent]
updated_at: 2026-09-12
tags: [draw.io, XML, SVG, 渲染, 可视化]
sources: []
public_evidence: original_sources_not_distributed
---

## 是什么／怎么做

修改既有 draw.io 文件时，优先在原始文本上做最小替换并保留未触及结构；历史案例中，用通用 XML 序列化器重写全文件会改变结构细节，造成形状或连线异常。调整 group 时还要区分父容器的绝对坐标与子元素相对坐标，并同步核对容器尺寸，避免移动后溢出。导出 SVG 后再用目标渲染器验证；若 `rsvg-convert` 把 `fill="none"` 渲染成黑底，可改用透明填充或显式背景矩形。

## 什么时候用

自动修改 draw.io 源文件、移动分组，或把其 SVG 导出为位图并发现结构、背景异常时使用。

## 什么时候别信

这些陷阱来自 2026-03 的具体文件和渲染器组合。当前 draw.io 版本、压缩格式和渲染器可能不同；先在副本上做最小样例并视觉回读，不把字符串替换当成任意 XML 编辑的通用方案。
