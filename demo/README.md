# 演示数据(P4.2 固定语料)

本目录的 ZIP 由 `pnpm demo:zip` 生成(**ZIP 本身不入库**,`.gitignore` 已忽略 `demo/*.zip`);语料来自版本化的 `tests/e2e/helpers.ts`(`SAMPLE_FILES` / `FIXED_FILES`),全部为本项目自有的合成代码,**不含他人源码与真实凭证**。语料结构由 `tests/unit/demo-corpus.test.ts` 契约测试锁定:若测试语料变动导致演示环节失效,`pnpm test:unit` 会失败提示。

## 生成

```bash
pnpm demo:zip
# → demo/codeatlas-demo-origin.zip(4 个文件)
# → demo/codeatlas-demo-fixed.zip(4 个文件,第二快照对比用)
```

## 原始版(codeatlas-demo-origin.zip)

| 文件 | 内容 | 覆盖的静态问题类别 |
| --- | --- | --- |
| `src/App.tsx` | `dangerouslySetInnerHTML` 渲染 `bio`;`List` 组件 `.map` 列表项缺 `key` | HTML 注入入口(html-injection)、JSX 列表缺失 key(jsx-key) |
| `src/danger.js` | `eval(code)` 动态执行;`window.addEventListener("message", …)` | 动态代码执行(dynamic-exec)、跨窗口消息源(postmessage) |
| `src/utils/format.ts` | 无问题的对照文件 | — |
| `package.json` | 清单文件 | — |

## 与演示脚本(docs/demo-script.md)的对应

- **审查与证据(第 3 段)**:首条「候选 HTML 注入入口」= `src/App.tsx:3`。
- **追问(第 4 段)**:在该 finding 的追问面板输入「这段输入经过净化了吗?」。
- **补丁(第 5 段)**:对该 finding 生成单文件补丁提案(Mock 示例,界面明确标注),验证可应用 / 语法 / 测试 `not_run` 三态并下载 `.patch`。
- **第二快照对比(第 5 段)**:上传修复版 ZIP → 再次审查 → 「快照对比」。

## 修复版(codeatlas-demo-fixed.zip)与对比预期

| 变化 | 问题 | 预期对比徽章 |
| --- | --- | --- |
| `App.tsx` 移除 `dangerouslySetInnerHTML` | html-injection | 未再检出(≠已验证修复,页面有固定说明) |
| `App.tsx` 缺 key 列表保留 | jsx-key | 仍存在 |
| `danger.js` 新增 `new Function(expr)` | dynamic-exec | 新增 |
| `eval` 与 message 监听保留 | dynamic-exec / postmessage | 仍存在 |

## 诚实标注

- Mock 环境下 AI 审查、追问回答、补丁提案均为确定性 Mock 输出,界面全程带「Mock(非真实模型)」标注;若已配置真实 provider(P2),标签会显示真实模型名。
- 上传后数据与本会话隔离,TTL 默认 24 小时;演示中不展示任何密钥、内部路径或未验证的准确率。
