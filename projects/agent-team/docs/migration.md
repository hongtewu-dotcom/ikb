# 迁移记录

## 来源

| 项目 | 值 |
|---|---|
| 上游仓库 | `https://github.com/wshobson/agents.git` |
| 本地首次 clone | 2026-08-06 13:04:46 +0800 |
| 抽取前 HEAD | `fc648d96b1535888d6ce62a12f935f33715434cc` |
| 抽取日期 | 2026-08-26 |
| 抽取目标 | `/Users/htwu/projects/_personal/ikb/projects/agent-team` |
| 原仓库处置 | 已压缩归档到 `/Users/htwu/Archives/agent-team/wshobson-agents-20260826.tar.gz`；废纸篓展开副本已删除 |
| 归档 SHA-256 | `be92c685382279f8dfac57c258f21b976d5cb2e09c8656fba2d16c697afa9655` |
| 归档校验 | gzip 完整性通过；源目录与归档均为 10,456 个条目；4 个关键文件逐字节一致 |

## 保留范围

- `plugins/agent-teams/` 的完整当前工作树，包括未提交的 Codex、Pi、Skill、Agent、命令、评测和文档改动。
- Codex/Pi 生成依赖的 `tools/adapters/base.py`、`capabilities.py`、`codex.py`、`pi.py`。
- `tools/generate.py`、`tools/validate_generated.py` 和 agent-team 相关测试。
- 上游 MIT LICENSE 与作者信息。

## 未迁移范围

- 上游其余插件、Agent、Skill 和命令。
- 与 agent-team 无关的文档、视频提取工具、插件评估框架实现和其他宿主 adapter。
- 当前安装缓存和全局软链接；它们属于运行安装态，不是项目源码。

## 证据边界

迁移只证明源码与最小测试链保留。它不代表现有方案已经正确，也不代表插件可安装。已知的 Claude 专属暴露、模型路由、重复入口和真实行为评测缺口由迁移后的方案继续处理。

## 卸载验收

| 检查 | 结果 |
|---|---|
| Codex plugin | `agent-teams@claude-code-workflows` 已移除 |
| Marketplace | `claude-code-workflows` 已移除 |
| 缓存与全局入口 | plugin cache、三份 Skill、reviewer 和中间层软链接均不存在 |
| 旧路径配置 | `~/.codex/config.toml` 不再包含 wshobson-agents 项目项 |
| 旧仓库归档 | 工作区外只读 tar.gz；无展开目录，不作为 marketplace、插件源码或软链接目标 |
| 新任务 canary | session `01a03cf8-e215-7283-abd0-c3c476f2bd8e` 返回 `agent_team_skill_present=false`、`matching_names=[]` |

新任务 canary 使用 Luna low、read-only、ephemeral 模式，只读取启动时注入的 Skill 清单，没有调用工具。

后续开发只使用 `/Users/htwu/projects/_personal/ikb/projects/agent-team`。归档仅用于历史比对；如确需读取，解压到临时目录，禁止从中注册 marketplace、安装插件或恢复全局软链接。
