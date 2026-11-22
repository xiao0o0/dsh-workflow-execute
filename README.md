# dsh-workflow-execute

DSH 插件 · 工作流执行：把「工作流」（多阶段 · 多环节的 agent 工作流模板）接进 dsh web——浏览、编辑、校验、导入导出、AI 生成，并在面板里按工作流逐环节开真实会话执行、门禁评审、看板跟踪。

## 核心功能

- **双库浏览**：我的库（默认 `~/.rjWorkflow/workflows`，可写）+ 内置库（默认 `~/.rjWorkflow/bundled/workflows`，只读），递归扫描分类子目录；侧栏入口显示两库计数，根目录可在设置里改
- **详情三视图**：概览（元信息 / 限额 / 诊断清单）、结构（阶段 → 环节树，prompt / 执行器 / 技能 / 门禁 / 流转全字段）、YAML（行号 + 着色，诊断点击跳行）
- **编辑器**：行号 + 边写边校验（300ms 防抖，自动校验不弹提示）；错误阻止保存、警告只黄标；`⌘/Ctrl+S` 保存；保存后停留在编辑器；乐观锁——外部改过文件给 409 与「重新加载 / 仍然覆盖」二选一
- **校验器**：语法错 / 缺 name / phases 空 / 环节 id 重复 / `on_gate_fail` `goto:` 指向不存在的环节 = 错误；缺 guid、未知键 = 警告
- **全套 CRUD**：新建（带注释骨架）/ 复制内置到我的库（自动换 guid）/ 重命名 / 删除（移入 `.trash`）
- **导入导出**：多文件导入（重名可选覆盖）、单个 yaml 下载、全库 zip
- **实时同步**：fs.watch 两个根目录 → SSE 变更帧 → 界面秒级刷新
- **AI 生成工作流**：需求 + 复杂度 → 真实 agent 会话产出一版 YAML → 校验 → 预览确认 → 写入我的库
- **执行**：面板里按工作流发起运行，逐环节开真实会话；支持「单会话」（整条流程一个会话，省 token）与「多会话」（每环节一个会话，隔离性好）；门禁由 AI 评审打分或停下等人工审核；看板看阶段/环节进度、耗时、token、产物
- **产物**：每环节声明的产物文件可在看板里直接查看内容；每次运行开始前把产物目录归档到 `workflow/<流程>/.history/<runId>/`
- **agent 协作**：`workflow_list` / `workflow_get` / `workflow_validate` / `workflow_save` 四个工具 + systemPrompt 段（按工作流推进：一环节一交付、门禁不过按 `on_gate_fail` 流转）；内置库对 agent 同样只读

## 安装

```bash
dsh plugin --profile web add dsh-workflow-execute
```

装完重启 `dsh web` 并刷新页面，侧栏「新会话」下方出现「工作流」入口即成功。零配置：默认读写 `~/.rjWorkflow` 下的工作流目录（可在 ⚙ 设置里改根目录、扫描深度）。

## 数据与配置

- **工作流库**：`~/.rjWorkflow/workflows`（我的库）、`~/.rjWorkflow/bundled/workflows`（内置库，只读）；可用环境变量 `RJ_WORKFLOW_HOME` 改根
- **插件设置**：`~/.dsh/dsh-workflow-execute/settings.json`（settings 命名空间 `dsh-workflow-execute`）
- **运行台账**：`~/.dsh/dsh-workflow-execute/runs.json`（快照冻结，改工作流不影响进行中的运行；宿主重启后运行自动转暂停，可继续）
- **环境变量**：`DSH_WORKFLOW_EXECUTE_MAX_CONCURRENT`（并发运行上限）、`DSH_WORKFLOW_EXECUTE_SETTINGS_DEBUG`（settings 写入调试日志）

## 运行要求

- dsh `>=0.1.7-rc.2`、Node `>=20`
- 依赖 `@weibaohui/dsh-plugin-kit`（客户端共享工具箱，构建期内联进 bundle）与 `yaml`
