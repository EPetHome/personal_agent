"""真实格式兼容批的场景样本：结构照 2026-10-25 对真实数据的统计编写（各工具出现过的记录类型都放进去当噪音），内容全部是编的。"""
import json, os, sys, uuid as _uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(sys.argv[1])


def t(s): return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
def iso(d): return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"
def uid(seed): return str(_uuid.uuid5(_uuid.NAMESPACE_URL, "pa-sample-v2/" + seed))
def wj(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
def wt(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


# ---------------- Claude Code（含真实出现过的各类噪音记录） ----------------
class CC:
    def __init__(self, scene, seed, cwd, start, origin=True, version="2.1.288"):
        self.sid = uid("cc/" + seed); self.cwd = cwd; self.now = t(start); self.rows = []
        self.parent = None; self.n = 0; self.origin = origin; self.version = version
        self.path = OUT / scene / "claude-projects" / cwd.replace("/", "-") / f"{self.sid}.jsonl"

    def _b(self, typ, minutes=0):
        self.now += timedelta(minutes=minutes); self.n += 1
        u = uid(f"cc/{self.sid}/{self.n}")
        r = {"parentUuid": self.parent, "isSidechain": False, "userType": "external", "cwd": self.cwd,
             "sessionId": self.sid, "version": self.version, "gitBranch": "main", "entrypoint": "sdk-ts",
             "type": typ, "uuid": u, "timestamp": iso(self.now)}
        self.parent = u; return r

    def meta(self, typ, extra, minutes=0):  # 没有 uuid 链的元数据行，真实里大量出现
        self.now += timedelta(minutes=minutes)
        r = {"type": typ, "sessionId": self.sid, "timestamp": iso(self.now)}; r.update(extra); self.rows.append(r)

    def noise(self):
        self.meta("last-prompt", {"lastPrompt": "（编的）上一条输入"})
        self.meta("atis-latch", {"latched": True})
        self.meta("queue-operation", {"operation": "enqueue", "content": "（编的）排队消息"})
        self.meta("file-history-snapshot", {"messageId": uid(f"{self.sid}/fh"), "snapshot": {
            "trackedFileBackups": {"/demo/x/src/a.ts": {"backupFileName": "a@v1", "version": 1}}, "timestamp": iso(self.now)},
            "isSnapshotUpdate": False})
        self.meta("mode", {"mode": "default"})
        self.meta("cost-state", {"totalCostUsd": 0.12})
        r = self._b("attachment"); r["attachment"] = {"type": "edited_text_file", "filename": "/demo/x/src/a.ts", "snippet": "（编的）"}; self.rows.append(r)

    def human(self, text, minutes=0, blocks=False):
        r = self._b("user", minutes)
        content = [{"type": "text", "text": text}] if blocks else text
        r["message"] = {"role": "user", "content": content}
        if self.origin:
            r.update({"promptSource": "sdk", "origin": {"kind": "human"}})
        self.rows.append(r)

    def injected(self, text, kind=None, minutes=0):
        r = self._b("user", minutes); r["message"] = {"role": "user", "content": text}
        if kind: r["origin"] = {"kind": kind, "producer": "background-task"}
        self.rows.append(r)

    def _a(self, content, stop, minutes):
        r = self._b("assistant", minutes)
        r["message"] = {"id": "msg_" + r["uuid"][:12], "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                        "content": content, "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 9}}
        self.rows.append(r)

    def think(self, minutes=1): self._a([{"type": "thinking", "thinking": "（编的思考）", "signature": "sig"}], None, minutes)
    def say(self, text, minutes=1): self._a([{"type": "text", "text": text}], "end_turn", minutes)

    def tool(self, name, inp, minutes=1):
        tid = "toolu_" + uid(f"{self.sid}/t/{self.n}").replace("-", "")[:20]
        self._a([{"type": "tool_use", "id": tid, "name": name, "input": inp, "caller": {"type": "direct"}}], "tool_use", minutes)
        return tid

    def result(self, tid, text, minutes=1):
        r = self._b("user", minutes)
        r.update({"message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": False}]},
                  "toolUseResult": {"stdout": text}})
        self.rows.append(r)

    def title(self, text): self.meta("ai-title", {"aiTitle": text})

    def stop(self, minutes=0):
        r = self._b("system", minutes)
        r.update({"subtype": "stop_hook_summary", "hookCount": 0, "hookInfos": [], "hookErrors": [], "preventedContinuation": False,
                  "stopReason": "", "hasOutput": False, "level": "suggestion"})
        self.rows.append(r)

    def save(self): wj(self.path, self.rows); return self


# ---------------- Codex（新版 0.162–0.164 结构） ----------------
class Codex:
    def __init__(self, scene, seed, cwd, start, parent=None):
        self.sid = uid("codex/" + seed); self.cwd = cwd; self.now = t(start); self.turn = uid(f"{self.sid}/turn")
        stamp = self.now.strftime("%Y-%m-%dT%H-%M-%S")
        self.path = OUT / scene / "codex-sessions" / self.now.strftime("%Y/%m/%d") / f"rollout-{stamp}-{self.sid}.jsonl"
        source = {"subagent": {"thread_spawn": {"parent_thread_id": parent.sid, "depth": 1, "agent_path": "worker",
                                                "agent_nickname": "助手", "agent_role": "worker"}}} if parent else "vscode"
        self.rows = [{"timestamp": iso(self.now), "type": "session_meta", "payload": {
            "id": self.sid, "session_id": self.sid, "timestamp": iso(self.now), "cwd": cwd, "originator": "codex_vscode",
            "source": source, "cli_version": "0.163.0-alpha.11.1", "model_provider": "openai", "history_mode": "default"}}]
        self.ord = 0

    def _r(self, typ, payload, minutes=0):
        self.now += timedelta(minutes=minutes)
        self.rows.append({"timestamp": iso(self.now), "type": typ, "payload": payload})

    def _item(self, item, minutes=0):
        self._r("event_msg", {"type": "item_completed", "thread_id": self.sid, "turn_id": self.turn, "item": item,
                              "started_at_ms": 0, "completed_at_ms": 1}, minutes)

    def noise(self):
        self._r("world_state", {"full": True, "state": {"open_files": 2}})
        self.ord += 1
        self.rows.append({"timestamp": iso(self.now), "type": "token_usage_record", "ordinal": self.ord,
                          "payload": {"input_tokens": 100, "output_tokens": 20}})
        self._r("event_msg", {"type": "thread_settings_applied", "thread_id": self.sid, "thread_settings": {"effort": "high"}})
        self._r("event_msg", {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 120}}})
        self._r("response_item", {"type": "reasoning", "id": uid(f"{self.sid}/rs/{len(self.rows)}"), "summary": [], "encrypted_content": "（编的）"})
        self._item({"type": "Reasoning", "id": uid(f"{self.sid}/ri/{len(self.rows)}"), "summary_text": ["（编的）"]})

    def user(self, text, minutes=0):
        self._r("turn_context", {"turn_id": self.turn, "root_turn_id": self.turn, "cwd": self.cwd, "model": "gpt-6.1",
                                 "approval_policy": "on-request", "effort": "high"}, minutes)
        self._r("event_msg", {"type": "task_started", "turn_id": self.turn, "root_turn_id": self.turn, "started_at": iso(self.now),
                              "model_context_window": 400000, "collaboration_mode_kind": "default"})
        self._r("response_item", {"type": "message", "role": "user", "id": uid(f"{self.sid}/um/{len(self.rows)}"),
                                  "content": [{"type": "input_text", "text": text}]})
        self._item({"type": "UserMessage", "id": uid(f"{self.sid}/ui/{len(self.rows)}"), "client_id": "c1",
                    "content": [{"type": "text", "text": text, "text_elements": []}]})

    def env(self):  # 系统塞进来的环境说明，真实里以 < 开头
        text = "<environment_context>\n  <cwd>" + self.cwd + "</cwd>\n</environment_context>"
        self._r("response_item", {"type": "message", "role": "user", "id": uid(f"{self.sid}/env"), "content": [{"type": "input_text", "text": text}]})
        self._item({"type": "UserMessage", "id": uid(f"{self.sid}/envi"), "client_id": "sys", "content": [{"type": "text", "text": text, "text_elements": []}]})

    def say(self, text, minutes=1):
        self._r("response_item", {"type": "message", "role": "assistant", "id": uid(f"{self.sid}/am/{len(self.rows)}"),
                                  "content": [{"type": "output_text", "text": text}]}, minutes)
        self._item({"type": "AgentMessage", "id": uid(f"{self.sid}/ai/{len(self.rows)}"), "phase": "commentary",
                    "content": [{"type": "text", "text": text}]})

    def command(self, cmd, minutes=1, done=True):
        cid = "call_" + uid(f"{self.sid}/c/{len(self.rows)}")[:16]
        self._r("response_item", {"type": "custom_tool_call", "id": uid(f"{self.sid}/cc/{len(self.rows)}"), "call_id": cid,
                                  "name": "exec_command", "input": json.dumps({"cmd": cmd}, ensure_ascii=False), "status": "completed"}, minutes)
        if done:
            self._r("response_item", {"type": "custom_tool_call_output", "id": uid(f"{self.sid}/co/{len(self.rows)}"), "call_id": cid, "output": "（编的输出）"}, 1)
            self._item({"type": "CommandExecution", "id": uid(f"{self.sid}/ce/{len(self.rows)}"), "command": cmd, "cwd": self.cwd,
                        "status": "completed", "exit_code": 0, "duration": 1.2, "aggregated_output": "（编的）",
                        "parsed_cmd": [], "process_id": 1, "source": "agent"})

    def file_change(self, path, minutes=1):
        self._item({"type": "FileChange", "id": uid(f"{self.sid}/fc/{len(self.rows)}"), "status": "completed", "stdout": "",
                    "changes": {path: {"type": "update"}}}, minutes)

    def complete(self, last, minutes=0):
        self._r("event_msg", {"type": "task_complete", "turn_id": self.turn, "root_turn_id": self.turn, "started_at": self.rows[0]["timestamp"],
                              "completed_at": iso(self.now), "duration_ms": 60000, "time_to_first_token_ms": 800,
                              "last_agent_message": last}, minutes)

    def save(self): wj(self.path, self.rows); return self


# ---------------- Pi ----------------
class Pi:
    def __init__(self, scene, seed, cwd, start):
        self.sid = uid("pi/" + seed); self.cwd = cwd; self.now = t(start); self.parent = None; self.n = 0
        enc = "--" + cwd.lstrip("/").replace("/", "-") + "--"
        self.path = OUT / scene / "pi-sessions" / enc / f"{self.now.strftime('%Y-%m-%dT%H-%M-%S-000Z')}_{self.sid}.jsonl"
        self.rows = [{"type": "session", "version": 3, "id": self.sid, "timestamp": iso(self.now), "cwd": cwd}]

    def entry(self, typ, extra, minutes=0):
        self.now += timedelta(minutes=minutes); self.n += 1
        eid = uid(f"pi/{self.sid}/{self.n}")[:8]
        r = {"type": typ, "id": eid, "parentId": self.parent, "timestamp": iso(self.now)}; r.update(extra)
        self.rows.append(r); self.parent = eid

    def msg(self, m, minutes=0):
        m["timestamp"] = int(self.now.timestamp() * 1000) + minutes * 60000
        self.entry("message", {"message": m}, minutes)

    def noise(self):
        self.entry("model_change", {"provider": "openai-codex", "modelId": "gpt-6.1-sol"})
        self.entry("thinking_level_change", {"thinkingLevel": "max"})
        self.msg({"role": "system", "content": "", "sections": {"preamble": "（编的）"}})
        self.entry("custom", {"customType": "autoreview-state", "data": {"phase": "dev"}})
        self.entry("session_info", {"name": "（编的会话名）"})

    def user(self, text, minutes=0): self.msg({"role": "user", "content": [{"type": "text", "text": text}]}, minutes)
    def custom_message(self, text, minutes=0):
        self.entry("custom_message", {"customType": "autoreview", "content": text, "display": True}, minutes)
    def say(self, text, minutes=1):
        self.msg({"role": "assistant", "content": [{"type": "text", "text": text}], "api": "openai-responses", "provider": "openai-codex",
                  "model": "gpt-6.1-sol", "stopReason": "stop", "usage": {}}, minutes)
    def tool(self, name, args, minutes=1):
        cid = "call_" + uid(f"pi/{self.sid}/t/{self.n}")[:12]
        self.msg({"role": "assistant", "content": [{"type": "thinking", "thinking": "（编的）"}, {"type": "toolCall", "id": cid, "name": name, "arguments": args}],
                  "api": "openai-responses", "provider": "openai-codex", "model": "gpt-6.1-sol", "stopReason": "toolUse", "usage": {}}, minutes)
        return cid
    def result(self, cid, name, text, minutes=1):
        self.msg({"role": "toolResult", "toolCallId": cid, "toolName": name, "content": [{"type": "text", "text": text}], "isError": False, "details": {}}, minutes)
    def save(self): wj(self.path, self.rows); return self


def loop_summary(base, proj_dir, project, seed, status, rounds, repairs, todo, prefix=""):
    dev = uid("loopdev/" + seed)
    todo_md = ("## 需要你做的事\n" + "\n".join(f"- {x}" for x in todo) + "\n") if todo is not None else ""
    text = f"""# 自动评审总结
- 已登记到交付总表：/demo/.pi-autoreview/交付记录.md；待回写原单
- 项目：{project}
- 开发会话：{dev}　评审会话：autoreview-rev-{dev}
- 状态：{status}
- 评审 {rounds} 次，返修 {repairs} 次
## 验收标准（你写的；第 1 版）
- A1. 操作：执行 `shop list`　预期：列出商品 —— 通过
{todo_md}## 各轮
### 第 1 轮（2026-10-20 13:00:00，耗时 120 秒）
- 无
## 改动文件
- src/list.ts
"""
    wt(base / proj_dir / f"{prefix}{dev}.md", text)
    return dev


def card(scene, situation, now, expect, basis):
    wt(OUT / scene / "卡片.md", f"""# {scene}

- 情况：{situation}
- 来源：照 2026-10-25 对本机真实数据的结构统计编写（{basis}），内容全部是编的
- 当前时间：{now}
- 预期：{expect}
""")


# ===== R1 Codex 新格式：噪音全集、意图在 item_completed[UserMessage]、子代理并入父会话 =====
S = "R1-Codex新格式"
p1 = Codex(S, "busy", "/demo/api", "2026-10-20T09:00:00")
p1.noise(); p1.env(); p1.user("给订单导出加一个 CSV 格式"); p1.noise()
p1.say("先看导出模块。"); p1.command(["cat", "src/export.ts"]); p1.noise()
p1.file_change("/demo/api/src/export.ts"); p1.command(["npm", "test"], done=False)
p1.save()
sub = Codex(S, "busy-sub", "/demo/api", "2026-10-20T09:03:00", parent=p1)
sub.noise(); sub.user("子任务：检查 CSV 列名"); sub.command(["grep", "-n", "columns", "src/export.ts"]); sub.complete("列名没问题。")
sub.save()
p2 = Codex(S, "done", "/demo/web", "2026-10-20T08:00:00")
p2.noise(); p2.env(); p2.user("把首页按钮颜色改成蓝色"); p2.command(["sed", "-i", "s/red/blue/", "src/home.css"])
p2.file_change("/demo/web/src/home.css"); p2.say("改好了。"); p2.noise(); p2.complete("改好了，按钮已是蓝色。")
p2.save()
card(S, "两个 Codex 会话：/demo/api 正在跑 npm test（还带一个已完成的子代理会话），/demo/web 已做完；文件里有真实出现过的各类记录（用量、环境、思考、设置变更等）和一条系统塞进来的环境说明",
     "2026-10-20T09:15:00Z",
     "总览里只有两行 Codex：/demo/api「进行中」、意图「给订单导出加一个 CSV 格式」（子代理并在它下面，不单独占一行）；/demo/web「已完成」、意图「把首页按钮颜色改成蓝色」；意图里没有 environment_context；没有任何「看不见了」",
     "Codex 182 份里 175 份含 token_usage_record、world_state；本人输入在 item_completed[UserMessage] 的有 158 份；66 份是子代理")

# ===== R2 Claude Code 噪音全集 + 旧版本没有 origin 标记 =====
S = "R2-CC噪音与旧版"
a = CC(S, "noise", "/demo/shop", "2026-10-20T10:00:00")
a.noise(); a.human("把购物车按钮文字改成「加入购物车」", blocks=True); a.title("改购物车按钮"); a.think()
x = a.tool("Edit", {"file_path": "/demo/shop/src/cart.vue"}); a.result(x, "ok"); a.noise(); a.say("改好了。"); a.stop()
a.save()
b = CC(S, "old", "/demo/blog", "2026-10-20T10:10:00", origin=False, version="2.0.10")
b.injected("<command-name>/clear</command-name>"); b.human("给博客加一个归档页")
x = b.tool("Write", {"file_path": "/demo/blog/archive.md"}); b.result(x, "ok"); b.say("归档页已加好。"); b.stop()
b.save()
card(S, "两个 Claude Code 会话：一个带真实出现过的各类元数据记录、本人输入是分块格式；一个是旧版本，没有「是不是本人说的」标记，还夹着一条以 < 开头的命令记录",
     "2026-10-20T10:30:00Z",
     "总览两行 Claude Code 都是「已完成」；意图分别是「把购物车按钮文字改成「加入购物车」」和「给博客加一个归档页」（不是 <command-name> 那条）；没有任何「看不见了」",
     "CC 258 份全部含 attachment、last-prompt 等元数据；49 份旧版本本人输入没有 origin 字段；本人输入分块格式出现在 233 份")

# ===== R3 Pi 老格式与各类记录 =====
S = "R3-Pi老格式"
p = Pi(S, "v3", "/demo/blog", "2026-10-20T11:00:00")
p.noise(); p.user("给博客首页加最近 5 篇文章"); k = p.tool("edit", {"path": "src/index.md"}); p.result(k, "edit", "ok")
p.custom_message("【自动评审 · 第 1 次返修】（编的返修消息）", minutes=1)
p.entry("context_edit", {"edits": []}); p.say("已加上。")
p.save()
old = OUT / S / "pi-sessions" / "--demo-old--" / f"2025-12-01T09-00-00-000Z_{uid('pi/v1')}.jsonl"
wj(old, [{"type": "header", "version": 1, "cwd": "/demo/old"}, {"role": "user", "content": "（编的老格式）"}])
card(S, "一个正常的 Pi v3 会话（带模型切换、自定义记录、loop 返修消息、上下文编辑等），外加一份 v1 老格式文件",
     "2026-10-20T11:30:00Z",
     "总览有一行 Pi：/demo/blog「已完成」，意图「给博客首页加最近 5 篇文章」，loop 返修消息不算你后来追加的要求；v1 老格式文件被跳过，不触发「看不见了」",
     "Pi 965 份里 962 份是 v3，3 份 v1；custom、custom_message、context_edit 等都出现过")

# ===== R4 loop 目录真实结构 =====
S = "R4-loop目录"
base = OUT / S / "pi-autoreview"
d1 = loop_summary(base, "shop", "/demo/shop", "s1", "完成", 2, 1, ["A2 需人工：看列表文案"])
d2 = loop_summary(base, "shop", "/demo/shop", "s2", "暂停（开发方需要你决定）", 1, 0, ["开发方问：价格为空显示什么"], prefix="claude-")
wt(base / "shop" / f"review-input-{d1}-r1.md", "# 评审输入（编的，不是总结）\n- 状态：完成\n")
wt(base / "shop" / f"gate-{d1}-r1.log", "（编的门禁日志）\n")
wt(base / "shop" / f"{d1}.state.json", json.dumps({"phase": "done"}))
wt(base / "shop" / "acceptance" / d1 / "r1" / "result.json", json.dumps({"A1": "pass"}))
wt(base / "shop" / "acceptance" / d1 / "r1" / "input.md", "# 验收输入（编的）\n- 状态：完成\n")
wt(base / "交付记录.md", "# 交付总表（编的）\n## 2026-10-20 · /demo/shop\n- 结果：完成\n")
wt(base / "projects" / "a1b2c3d4" / "context.md", "# 来源索引（编的）\n")
wt(base / "pipelines" / "示例" / "report.md", "# 流水线报告（编的）\n- 状态：完成\n")
for i in range(30):
    wt(base / "resources" / uid(f"res/{i}") / "evidence" / f"e{i}.md", "# 证据（编的）\n- 状态：完成\n")
os.symlink("/demo/does-not-exist", base / "shop" / "最新.md")
card(S, "loop 目录照真实结构：项目目录下两份真总结（一份完成、一份以 claude- 开头且暂停），旁边是评审输入、门禁日志、状态文件、验收材料、一个指向别处的符号链接；根目录下有交付总表、projects、pipelines、resources（30 份证据文件）",
     "2026-10-20T13:30:00Z",
     "只认出两次 loop 运行：完成的发「有空看」交代，暂停的发「现在就要你」；其余文件都不当总结读，不出现「看不见了」",
     "~/.pi-autoreview 下真总结 178 份都在「项目目录/<会话号>.md」或带 claude-/codex- 前缀；另有 23 万多个非总结文件")

# ===== R5 一份坏文件不连累整个来源 =====
S = "R5-一份坏文件"
for i, (proj, task) in enumerate([("/demo/a", "改 A 页标题"), ("/demo/b", "改 B 页标题"), ("/demo/c", "改 C 页标题"), ("/demo/d", "改 D 页标题")]):
    c = CC(S, f"good{i}", proj, f"2026-10-20T12:0{i}:00"); c.human(task); x = c.tool("Edit", {"file_path": proj + "/page.vue"}); c.result(x, "ok"); c.say("改好了。"); c.stop(); c.save()
wt(OUT / S / "claude-projects" / "-demo-e" / f"{uid('cc/broken')}.jsonl", '{"type":"user","sessionId":\n这一行坏了\n')
card(S, "五份 Claude Code 会话，其中一份内容损坏", "2026-10-20T12:30:00Z",
     "总览里四个正常会话照常显示「已完成」；坏的那一份只在一条提醒里出现，写「Claude Code 有 1 份会话读不了」，附不超过 3 个例子，整条提醒不超过 4 KB；Claude Code 不被判成整体看不见",
     "第一批回放时 Claude Code 只有 3 份读不了，却让 255 个会话全部失明")

# ===== R6 整个来源读不了 =====
S = "R6-来源目录不存在"
c = CC(S, "ok", "/demo/shop", "2026-10-20T14:00:00"); c.human("改首页标题"); c.say("好的。"); c.stop(); c.save()
card(S, "Claude Code 来源正常；Codex 来源配置成一个不存在的目录 <场景目录>/codex-sessions-missing", "2026-10-20T14:10:00Z",
     "一条「现在就要你」提醒：Codex 看不见了，写明原因是目录读不了；Claude Code 会话照常显示",
     "核心信号整体取不到时才算看不见（感知原则）")

# ===== R7 表情与长文本 =====
S = "R7-表情与长文本"
c = CC(S, "emoji", "/demo/shop", "2026-10-20T15:00:00")
c.human("🚀 把首页横幅改成「双十一🎉大促」，" + "并且" * 400 + "😀 结尾")
x = c.tool("Bash", {"command": "echo 🎉"}); c.result(x, "🎉"); c.say("改好了 👍"); c.stop(); c.save()
card(S, "一个 Claude Code 会话，意图里有表情，而且很长（超过 1000 字）", "2026-10-20T15:10:00Z",
     "检测和总览的 --json 输出都能被标准 JSON 解析器完整读出；数据目录里每个文件逐行都是合法 JSON；总览里意图被截短但没有乱码",
     "第一批回放时输出里出现被截断的半个表情，导致 JSON 读不回来")

# ===== R8 临时目录里的测试会话 =====
S = "R8-临时目录会话"
for proj, task in [("/demo/shop", "改首页标题"), ("/private/tmp/autoreview-host-claude", "（编的）loop 自测"), ("/var/folders/ab/T/e2e-demo", "（编的）e2e 自测")]:
    c = CC(S, "tmp" + proj, proj, "2026-10-20T16:00:00"); c.human(task); c.say("好。"); c.stop(); c.save()
card(S, "三个 Claude Code 会话，其中两个项目目录在 /private/tmp 和 /var/folders 下（loop 自测留下的）", "2026-10-20T16:10:00Z",
     "配置里写上要忽略的目录前缀后，总览只剩 /demo/shop 一行；不配置时三行都在",
     "第一批回放时有 72 个会话的项目在临时目录下")

# ===== R9 空跑不膨胀 =====
S = "R9-空跑不膨胀"
c = CC(S, "idle", "/demo/shop", "2026-10-20T17:00:00"); c.human("改首页标题"); x = c.tool("Edit", {"file_path": "/demo/shop/a.vue"}); c.result(x, "ok"); c.say("好了。"); c.stop(); c.save()
cx = Codex(S, "idle", "/demo/api", "2026-10-20T17:00:00"); cx.noise(); cx.user("补接口文档"); cx.command(["ls"]); cx.complete("补好了。"); cx.save()
card(S, "两个已经结束、不再变化的会话", "依次用 2026-10-20T17:30:00Z、17:35:00Z、17:40:00Z 各跑一轮",
     "第 2、3 轮各自让数据目录增加不超过 10 KB，发件记录不增加",
     "第一批回放时一轮就写了 100 多 MB 数据，常驻后每几分钟一轮")

wt(OUT / "README.md", """# 真实格式兼容批的场景样本

照 2026-10-25 对本机真实数据的只读结构统计编写：各工具真实出现过的记录类型都编进去当噪音，内容全部是编的。只读，开发方和验收方都不要改。

子目录对应关系和第一批一样：`claude-projects/`、`codex-sessions/`、`pi-sessions/`、`pi-autoreview/`、`inbox/`；场景里没有的子目录表示该来源为空（R6 例外，见卡片）。每个场景的 `卡片.md` 写明情况、依据的真实统计、当前时间和预期。数据目录一律用新的临时目录。

第一批的场景样本仍在 `../../闭环1-感知与总览-20261025/samples/`，本批改动后它们也要照常通过。
""")
print("done")
