# 协作日志

本地开发 agent 与云端 agent（GitHub 仓库直连）之间的交接记录。

- **开工前**：读最上面几条，确认对方最近改了什么、留下了什么待办。
- **完成一项工作后**（一次合并、一个 PR、一次值得交代的提交）：在「记录」最上面加一条，与代码放在同一个提交或 PR 里。
- 只追加新条目，不改别人的旧条目；待办完成后，在自己的新条目里写明「已处理 XX 日的待办」。
- 两边同时追加导致冲突时，两条都保留，按时间排序。
- 长期有效的决定和项目背景仍写在 `docs/handoff.md`，这里只记「谁在什么时候做了什么」。

条目格式：

```
### YYYY-MM-DD · 本地 / 云端 · 一句话标题
- 分支 / PR：
- 做了什么：
- 怎么验证的：
- 留给对方：（没有就写"无"）
```

## 记录

### 2026-09-29 · 云端 · 加 GitHub Actions CI，修复职能标签 e2e 用例的偶发失败
- 分支 / PR：`claude/compassionate-babbage-ei9baf`
- 做了什么：
  - 新增 `.github/workflows/ci.yml`，PR 和推送到 `main` 时并行跑三个任务：类型检查 + 单元测试、Playwright 端到端测试、`scripts/smoke.sh` 镜像冒烟测试。前两个任务用 `pgvector/pgvector:pg17` 服务容器，映射到 54329 端口，账号与 `docker-compose.dev.yml` 一致，测试代码无需改动。端到端测试失败时上传 `apps/web/test-results/`（含 trace）作为构建产物。
  - 修复 `apps/web/e2e/tags.spec.ts` 的偶发失败：`getByRole('textbox', { name: '标签名称' })` 默认是子串匹配，会同时匹配新增表单里的「新标签名称」输入框。点「添加」后表单要等列表重新请求完才关闭，这段时间里「4 个标签 + 表单输入框」恰好凑满 5 个，于是 `.last()` 选中了「测试」那一行。改为 `exact: true`。
  - 新增本文档，并在 `CLAUDE.md`、`docs/handoff.md` 中指向它。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm test` 通过（core 113、web 75）；e2e 全部 17 个通过，`tags.spec.ts` 连续重复 8 次全部通过。冒烟测试在云端容器里跑不了（沙箱代理证书在 docker build 内不受信任），以 GitHub Actions 上的首次运行为准。
- 留给对方：
  - `pnpm --filter @flower/web lint` 目前有 7 个错误、3 个警告（如 `apps/web/test/api/helpers.ts` 的 `no-explicit-any`），所以暂未放进 CI。清理完后可以在 CI 的 test 任务里加一步 lint。
  - `docs/handoff.md` 里「当前进度」还写着「P0-B 尚未开始」，实际已由 PR #2 合并，下次更新时顺手改掉。
