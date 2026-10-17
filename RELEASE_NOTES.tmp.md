# v1.1.1 — 超时默认放宽到 90 秒

## 变更

- **默认 `thinkingOnlyMs` 从 45000 改为 90000**。flash 类模型在做深度推理时，经常出现几十秒"只有思考、没有正文、没有工具调用"的静默期，45 秒会误伤这类正常回合；90 秒仍能兜住真正卡死的空转。
- 文档同步：README 的档位表、调参表，以及 `cordis.patch.yml` 模板都已更新。

## 升级方式

1. 用新版本覆盖 `lib/index.js` 与 `cordis.patch.yml`
2. 如果你自己的 `cordis.patch.yml` 里写死了 `thinkingOnlyMs: 45000`，记得改成 `90000`
3. 重启 DSH

## 还想更宽松

`thinkingOnlyMs` 是普通配置项，改完保存即热重载，不用重启：

```yaml
config:
  thinkingOnlyMs: 180000   # 3 分钟
```

## 测试

19 条回归用例全部通过。
