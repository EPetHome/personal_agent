"""生成闭环 1 第一批的场景样本：结构照真实文件，内容全部是编的。"""
import json, sys, uuid as _uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(sys.argv[1])
CC_VER = "2.1.288"
CODEX_VER = "0.163.0-alpha.11.1"


def t(s):  # "2026-10-20T10:00:00" -> datetime
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def uid(seed):
    return str(_uuid.uuid5(_uuid.NAMESPACE_URL, "pa-sample/" + seed))


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


# ---------- Claude Code ----------
class CC:
    def __init__(self, scene, sid_seed, cwd, start):
        self.sid = uid("cc/" + sid_seed)
        self.cwd = cwd
        self.now = t(start)
        self.rows = []
        self.parent = None
        self.n = 0
        enc = cwd.replace("/", "-")
        self.path = OUT / scene / "claude-projects" / enc / f"{self.sid}.jsonl"

    def _base(self, typ, minutes):
        self.now += timedelta(minutes=minutes)
        self.n += 1
        u = uid(f"cc/{self.sid}/{self.n}")
        row = {"parentUuid": self.parent, "isSidechain": False, "userType": "external",
               "cwd": self.cwd, "sessionId": self.sid, "version": CC_VER, "gitBranch": "main",
               "entrypoint": "sdk-ts", "type": typ, "uuid": u, "timestamp": iso(self.now)}
        self.parent = u
        return row

    def human(self, text, minutes=0):
        r = self._base("user", minutes)
        r.update({"promptSource": "sdk", "origin": {"kind": "human"},
                  "message": {"role": "user", "content": text}})
        self.rows.append(r)

    def notification(self, text, minutes=0):
        r = self._base("user", minutes)
        r.update({"promptSource": "system", "origin": {"kind": "task-notification", "producer": "background-task"},
                  "message": {"role": "user", "content": text}})
        self.rows.append(r)

    def _assistant(self, content, stop, minutes):
        r = self._base("assistant", minutes)
        r["message"] = {"id": "msg_" + r["uuid"][:12], "type": "message", "role": "assistant",
                        "model": "claude-opus-5-5", "content": content, "stop_reason": stop,
                        "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 50}}
        self.rows.append(r)

    def say(self, text, minutes=1):
        self._assistant([{"type": "text", "text": text}], "end_turn", minutes)

    def tool(self, name, inp, minutes=1):
        tid = "toolu_" + uid(f"{self.sid}/tool/{self.n}")[:20].replace("-", "")
        self._assistant([{"type": "tool_use", "id": tid, "name": name, "input": inp, "caller": {"type": "direct"}}],
                        "tool_use", minutes)
        return tid

    def result(self, tid, text, minutes=1):
        r = self._base("user", minutes)
        r.update({"message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": False}]},
            "toolUseResult": {"stdout": text, "stderr": "", "interrupted": False}})
        self.rows.append(r)

    def stop_summary(self, minutes=0):
        r = self._base("system", minutes)
        r.update({"subtype": "stop_hook_summary", "hookCount": 0, "hookInfos": [], "hookErrors": [],
                  "preventedContinuation": False, "stopReason": "", "hasOutput": False, "level": "suggestion"})
        self.rows.append(r)

    def save(self):
        write_jsonl(self.path, self.rows)
        return self


# ---------- Codex ----------
class Codex:
    def __init__(self, scene, sid_seed, cwd, start):
        self.sid = uid("codex/" + sid_seed)
        self.cwd = cwd
        self.now = t(start)
        self.turn = uid(f"codex/{self.sid}/turn1")
        stamp = self.now.strftime("%Y-%m-%dT%H-%M-%S")
        self.path = (OUT / scene / "codex-sessions" / self.now.strftime("%Y/%m/%d")
                     / f"rollout-{stamp}-{self.sid}.jsonl")
        self.rows = [
            {"timestamp": iso(self.now), "type": "session_meta", "payload": {
                "id": self.sid, "session_id": self.sid, "timestamp": iso(self.now), "cwd": cwd,
                "originator": "codex_vscode", "source": "vscode", "cli_version": CODEX_VER,
                "model_provider": "openai", "history_mode": "default"}},
            {"timestamp": iso(self.now), "type": "turn_context", "payload": {
                "turn_id": self.turn, "root_turn_id": self.turn, "cwd": cwd, "model": "gpt-6.1",
                "approval_policy": "on-request", "effort": "high"}},
        ]

    def _row(self, typ, payload, minutes):
        self.now += timedelta(minutes=minutes)
        self.rows.append({"timestamp": iso(self.now), "type": typ, "payload": payload})

    def user(self, text, minutes=0):
        self._row("event_msg", {"type": "task_started", "turn_id": self.turn, "root_turn_id": self.turn,
                                "started_at": iso(self.now), "model_context_window": 400000}, minutes)
        self._row("event_msg", {"type": "user_message", "message": text, "images": [], "text_elements": []}, 0)
        self._row("response_item", {"type": "message", "role": "user", "id": uid(f"{self.sid}/u/{len(self.rows)}"),
                                    "content": [{"type": "input_text", "text": text}]}, 0)

    def say(self, text, minutes=1):
        self._row("event_msg", {"type": "agent_message", "message": text, "phase": "commentary"}, minutes)
        self._row("response_item", {"type": "message", "role": "assistant", "id": uid(f"{self.sid}/a/{len(self.rows)}"),
                                    "content": [{"type": "output_text", "text": text}]}, 0)

    def call(self, name, args, minutes=1, status="completed"):
        cid = "call_" + uid(f"{self.sid}/c/{len(self.rows)}")[:16]
        self._row("response_item", {"type": "function_call", "id": uid(f"{self.sid}/fc/{len(self.rows)}"),
                                    "call_id": cid, "name": name, "arguments": json.dumps(args, ensure_ascii=False),
                                    "status": status}, minutes)
        return cid

    def output(self, cid, text, minutes=1):
        self._row("response_item", {"type": "function_call_output", "id": uid(f"{self.sid}/fo/{len(self.rows)}"),
                                    "call_id": cid, "output": text}, minutes)

    def complete(self, last, minutes=0):
        self._row("event_msg", {"type": "task_complete", "turn_id": self.turn, "root_turn_id": self.turn,
                                "started_at": self.rows[0]["timestamp"], "completed_at": iso(self.now),
                                "duration_ms": 60000, "last_agent_message": last}, minutes)

    def save(self):
        write_jsonl(self.path, self.rows)
        return self


# ---------- Pi ----------
class Pi:
    def __init__(self, scene, sid_seed, cwd, start):
        self.sid = uid("pi/" + sid_seed)
        self.cwd = cwd
        self.now = t(start)
        self.parent = None
        self.n = 0
        enc = "--" + cwd.lstrip("/").replace("/", "-") + "--"
        stamp = self.now.strftime("%Y-%m-%dT%H-%M-%S-000Z")
        self.path = OUT / scene / "pi-sessions" / enc / f"{stamp}_{self.sid}.jsonl"
        self.rows = [{"type": "session", "version": 3, "id": self.sid, "timestamp": iso(self.now), "cwd": cwd}]

    def _msg(self, message, minutes):
        self.now += timedelta(minutes=minutes)
        self.n += 1
        eid = uid(f"pi/{self.sid}/{self.n}")[:8]
        message["timestamp"] = int(self.now.timestamp() * 1000)
        self.rows.append({"type": "message", "id": eid, "parentId": self.parent, "timestamp": iso(self.now),
                          "message": message})
        self.parent = eid

    def user(self, text, minutes=0):
        self._msg({"role": "user", "content": [{"type": "text", "text": text}]}, minutes)

    def say(self, text, minutes=1):
        self._msg({"role": "assistant", "content": [{"type": "text", "text": text}], "api": "openai-responses",
                   "provider": "openai-codex", "model": "gpt-6.1-sol", "stopReason": "stop", "usage": {}}, minutes)

    def tool(self, name, args, minutes=1):
        cid = "call_" + uid(f"pi/{self.sid}/t/{self.n}")[:12]
        self._msg({"role": "assistant", "content": [{"type": "toolCall", "id": cid, "name": name, "arguments": args}],
                   "api": "openai-responses", "provider": "openai-codex", "model": "gpt-6.1-sol",
                   "stopReason": "toolUse", "usage": {}}, minutes)
        return cid

    def result(self, cid, name, text, minutes=1):
        self._msg({"role": "toolResult", "toolCallId": cid, "toolName": name,
                   "content": [{"type": "text", "text": text}], "isError": False}, minutes)

    def save(self):
        write_jsonl(self.path, self.rows)
        return self


def inbox(scene, tool, events):
    write_jsonl(OUT / scene / "inbox" / f"{tool}.jsonl", events)


def ev(tool, event, s, at, detail=""):
    return {"tool": tool, "event": event, "session_id": s.sid, "cwd": s.cwd,
            "transcript_path": str(s.path.resolve()), "at": iso(t(at)), "detail": detail}


def loop_summary(scene, project, dev_sid_seed, status, rounds, repairs, todo, when):
    dev = uid("loopdev/" + dev_sid_seed)
    name = project.rstrip("/").split("/")[-1]
    todo_md = "\n".join(f"- {x}" for x in todo) if todo else "- 无"
    text = f"""# 自动评审总结
- 项目：{project}
- 开发会话：{dev}　评审会话：autoreview-rev-{dev}
- 状态：{status}
- 评审 {rounds} 次，返修 {repairs} 次
## 验收标准（你写的；第 1 版）
- A1. 操作：执行 `shop list`　预期：列出商品 —— 通过
- A2. [人工] 操作：看列表文案　预期：文案是你想要的 —— 需人工
## 需要你做的事
{todo_md}
## 各轮
### 第 1 轮（{when}，耗时 120 秒）
- 无
## 改动文件
- src/list.ts
"""
    write_text(OUT / scene / "pi-autoreview" / name / f"{dev}.md", text)


def card(scene, situation, now, expect, notes=""):
    write_text(OUT / scene / "卡片.md", f"""# {scene}

- 情况：{situation}
- 来源：协调方照真实文件结构编写，内容全部是编的（2026-10-25）
- 当前时间：{now}
- 预期：{expect}
{notes}""")


# ===== 01 等授权：三个工具各一份，外加推送事件 =====
S = "01-等授权"
cc = CC(S, "wait", "/demo/shop", "2026-10-20T09:00:00")
cc.human("把商品列表接口的缓存时间改成 5 分钟，改完提交并推到远端")
cc.say("好的，我先看一下缓存配置。")
a = cc.tool("Read", {"file_path": "/demo/shop/src/cache.ts"})
cc.result(a, "export const TTL = 60;")
a = cc.tool("Edit", {"file_path": "/demo/shop/src/cache.ts", "old_string": "60", "new_string": "300"})
cc.result(a, "ok")
cc.tool("Bash", {"command": "git push origin main", "description": "推送到远端"})
cc.save()
cx = Codex(S, "wait", "/demo/api", "2026-10-20T09:05:00")
cx.user("给订单导出加一个 CSV 格式，做完把依赖装上")
cx.say("先看导出模块。")
c = cx.call("shell", {"command": ["cat", "src/export.ts"]})
cx.output(c, "export function toJson() {}")
cx.call("shell", {"command": ["npm", "install", "csv-writer"]}, status="in_progress")
cx.save()
pi = Pi(S, "wait", "/demo/blog", "2026-10-20T09:10:00")
pi.user("清理旧的构建产物，然后重新构建博客")
pi.say("我先看看构建目录。")
k = pi.tool("bash", {"command": "ls build"})
pi.result(k, "bash", "index.html  assets")
pi.tool("bash", {"command": "rm -rf build"})
pi.save()
inbox(S, "cc", [ev("cc", "waiting_permission", cc, "2026-10-20T09:06:30", "Claude needs your permission to use Bash")])
inbox(S, "codex", [ev("codex", "waiting_permission", cx, "2026-10-20T09:09:30", "安装依赖 csv-writer")])
inbox(S, "pi", [ev("pi", "waiting_permission", pi, "2026-10-20T09:14:30", "bash: rm -rf build")])
card(S, "Claude Code 想执行 git push、Codex 想安装依赖、Pi 想删除 build 目录，三个都停下等授权；推送事件目录里各有一条等授权事件",
     "2026-10-20T09:20:00Z",
     "三条「现在就要你」提醒，工具名分别是 Claude Code、Codex、Pi，各写项目目录（/demo/shop、/demo/api、/demo/blog）、开工指令原文、在等你授权做什么、一条回去看的命令；给人看的文字里没有内部编号")

# ===== 02 干到一半：最后一步跑测试没返回 =====
S = "02-干到一半"
cc = CC(S, "half", "/demo/api", "2026-10-20T10:00:00")
cc.human("给订单接口加分页参数，跑通测试")
cc.say("先改接口。")
a = cc.tool("Edit", {"file_path": "/demo/api/src/orders.ts", "old_string": "list()", "new_string": "list(page, size)"})
cc.result(a, "ok", minutes=2)
a = cc.tool("Edit", {"file_path": "/demo/api/test/orders.test.ts", "old_string": "list()", "new_string": "list(1, 20)"})
cc.result(a, "ok", minutes=2)
cc.tool("Bash", {"command": "npm test", "description": "跑测试"}, minutes=13)
cc.save()
last = cc.rows[-1]["timestamp"]
card(S, f"Claude Code 改完两个文件后开始跑 npm test，一直没返回；最后一条记录时间 {last}，没有会话结束事件",
     "依次用 2026-10-20T10:49:00Z（29 分钟）、2026-10-20T10:51:00Z（31 分钟）、2026-10-20T11:00:00Z（40 分钟）",
     "29 分钟：没有停滞提醒，总览里是「进行中」；31 分钟：多一条「有空看」停滞提醒，写明最后在跑 npm test、停了多久、之前改了哪两个文件；40 分钟：不再多发")

# ===== 03 看不见了：一份坏掉的 Codex 文件 + 一份正常的 CC =====
S = "03-看不见了"
cc = CC(S, "blind-ok", "/demo/shop", "2026-10-20T11:00:00")
cc.human("把首页标题改成「本周特价」")
a = cc.tool("Edit", {"file_path": "/demo/shop/src/home.vue", "old_string": "首页", "new_string": "本周特价"})
cc.result(a, "ok")
cc.say("已改好首页标题。")
cc.stop_summary()
cc.save()
bad = OUT / S / "codex-sessions" / "2026/10/20" / f"rollout-2026-10-20T11-10-00-{uid('codex/broken')}.jsonl"
write_text(bad, '{"timestamp":"2026-10-20T11:10:00.000Z","type":"session_meta","payload":{"id":\n'
                '这一行不是 JSON，模拟格式变了或文件损坏\n'
                '{"v":99,"kind":"unknown_future_format"}\n')
card(S, "Codex 来源目录里有一份读不出来的会话文件（模拟升级后格式变了）；Claude Code 来源里有一份正常做完的会话",
     "2026-10-20T12:00:00Z",
     "一条「现在就要你」提醒：看不见 Codex，写明从什么时候开始；Claude Code 的会话照常出现在总览里（已完成）")

# ===== 04 loop 暂停 =====
S = "04-loop暂停"
loop_summary(S, "/demo/shop", "pause", "暂停（开发方需要你决定）", 2, 1,
             ["开发方问：商品价格为空时显示「—」还是「0」？等你决定"], "2026-10-20 13:00:00")
card(S, "loop 一次运行暂停，原因是开发方需要你决定", "2026-10-20T13:10:00Z",
     "一条「现在就要你」提醒，写有项目路径 /demo/shop、暂停原因、总结文件路径")

# ===== 05 loop 完成 =====
S = "05-loop完成"
loop_summary(S, "/demo/shop", "done", "完成", 3, 2,
             ["A2 需人工：看列表文案是不是你想要的"], "2026-10-20 14:00:00")
card(S, "loop 一次运行完成，评审 3 次返修 2 次，还欠一条需人工验收", "2026-10-20T14:10:00Z",
     "一条「有空看」交代，写有结论（完成）、评审 3 次返修 2 次、还欠什么（A2 需人工）、总结文件路径")

# ===== 06 正常做完 =====
S = "06-正常做完"
cc = CC(S, "done", "/demo/shop", "2026-10-20T15:00:00")
cc.human("把购物车按钮的文字改成「加入购物车」")
cc.say("我来改按钮文字。")
a = cc.tool("Edit", {"file_path": "/demo/shop/src/cart.vue", "old_string": "购买", "new_string": "加入购物车"})
cc.result(a, "ok")
a = cc.tool("Bash", {"command": "npm test", "description": "跑测试"})
cc.result(a, "12 passing")
cc.say("已改好，测试 12 条全部通过。")
cc.stop_summary()
cc.save()
card(S, "Claude Code 改完按钮文字、测试通过、答完收尾", "2026-10-20T15:20:00Z",
     "总览里这个会话是「已完成」；发件记录里没有它的提醒")

# ===== 07 全部正常：总览 =====
S = "07-全部正常"
cc = CC(S, "all-cc", "/demo/shop", "2026-10-20T16:00:00")
cc.human("把商品详情页的价格改成两位小数")
a = cc.tool("Edit", {"file_path": "/demo/shop/src/price.ts", "old_string": "toFixed(0)", "new_string": "toFixed(2)"})
cc.result(a, "ok")
cc.say("已改成两位小数。")
cc.stop_summary()
cc.save()
cx = Codex(S, "all-codex", "/demo/api", "2026-10-20T16:20:00")
cx.user("给用户接口补上邮箱格式校验")
cx.say("先看校验模块。")
c = cx.call("shell", {"command": ["cat", "src/validate.ts"]})
cx.output(c, "export function check() {}")
cx.call("apply_patch", {"input": "*** 改 src/validate.ts"}, minutes=2)
cx.save()
pi = Pi(S, "all-pi", "/demo/blog", "2026-10-20T16:05:00")
pi.user("给博客首页加上最近 5 篇文章列表")
k = pi.tool("edit", {"path": "src/index.md", "oldText": "", "newText": "最近文章"})
pi.result(k, "edit", "ok")
pi.say("已加上最近 5 篇文章列表。")
pi.save()
loop_summary(S, "/demo/shop", "all-loop", "完成", 1, 0, [], "2026-10-20 16:10:00")
card(S, "四个来源各有正常会话：Claude Code 已做完、Codex 正在改代码、Pi 已做完、loop 一次运行完成",
     "2026-10-20T16:30:00Z",
     "总览每个会话一行，写有工具、项目、意图、状态、最后活动时间：Claude Code 已完成、Codex 进行中、Pi 已完成、loop 完成")

# ===== 08 追加要求：只认你本人 =====
S = "08-追加要求"
cc = CC(S, "addon", "/demo/shop", "2026-10-20T17:00:00")
cc.human("只改登录页的提示文案，不动逻辑")
a = cc.tool("Edit", {"file_path": "/demo/shop/src/login.vue", "old_string": "登录失败", "new_string": "账号或密码不对"})
cc.result(a, "ok")
cc.human("顺便把注册页的同一句文案也改了", minutes=3)
cc.notification("<task-notification>后台任务「lint」已完成，0 个问题</task-notification>", minutes=1)
a = cc.tool("Edit", {"file_path": "/demo/shop/src/register.vue", "old_string": "登录失败", "new_string": "账号或密码不对"})
cc.result(a, "ok")
cc.tool("Bash", {"command": "npm run build", "description": "构建"}, minutes=1)
cc.save()
last = cc.rows[-1]["timestamp"]
card(S, f"开工指令只改登录页；中途你本人追加「顺便把注册页的同一句文案也改了」；系统塞进来一条后台任务通知；最后在跑构建没返回，最后一条记录 {last}",
     "2026-10-20T17:40:00Z",
     "一条停滞提醒，证据里「你后来追加的要求」只有「顺便把注册页的同一句文案也改了」，没有那条后台任务通知")

# ===== 总表 =====
write_text(OUT / "README.md", """# 闭环 1 第一批场景样本

全部由协调方照真实文件结构编写，内容是编的，没有任何真实会话内容。只读：开发方和验收方都不要改这里的文件。

每个场景目录自成一套来源，配置时把各来源指到对应子目录：

| 子目录 | 对应真实来源 |
|---|---|
| `claude-projects/` | `~/.claude/projects` |
| `codex-sessions/` | `~/.codex/sessions` |
| `pi-sessions/` | `~/.pi/agent/sessions` |
| `pi-autoreview/` | `~/.pi-autoreview` |
| `inbox/` | 推送事件目录（message-listener 写的事件） |

场景里没有的子目录，表示这个来源在该场景下为空。每个场景的 `卡片.md` 写明情况、来源、用什么当前时间、预期。数据目录一律用临时目录，不要指到样本里。

| 场景 | 对应第一批验收 |
|---|---|
| 01-等授权 | 三个工具都能认出「在等你」 |
| 02-干到一半 | 停滞：29 分钟不叫、31 分钟叫、40 分钟不重复 |
| 03-看不见了 | 盯防自己看不见了 |
| 04-loop暂停 | loop 暂停叫你 |
| 05-loop完成 | loop 完成发交代 |
| 06-正常做完 | 正常做完不叫你 |
| 07-全部正常 | 总览 |
| 08-追加要求 | 追加要求只认你本人 |

只读验收（跑前后比对指纹）和「没配置就拒绝运行」可以用任意场景。
""")
print("done", OUT)
