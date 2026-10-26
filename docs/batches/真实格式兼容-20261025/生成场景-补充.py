"""补两个场景：R10 首次接入、R11 已搁置（2026-10-25 用户拍板的新规则）。复用 make_scenes_v2.py 里的类。"""
import sys
from pathlib import Path

src = Path(sys.argv[2]).read_text()
exec(src.split("# ===== R1")[0])  # 只取类和工具函数，不重跑已有场景


def summary_at(base, proj_dir, project, seed, status, round_local, todo):
    dev = uid("loopdev/" + seed)
    wt(base / proj_dir / f"{dev}.md", f"""# 自动评审总结
- 项目：{project}
- 开发会话：{dev}　评审会话：autoreview-rev-{dev}
- 状态：{status}
- 评审 1 次，返修 0 次
## 需要你做的事
{chr(10).join('- ' + x for x in todo) if todo else '- 无'}
## 各轮
### 第 1 轮（{round_local}，耗时 60 秒）
- 无
""")


# ===== R10 首次接入：只对最近 1 小时内的事提醒，更早的只进总览 =====
S = "R10-首次接入"
a = CC(S, "recent", "/demo/shop", "2026-10-20T17:25:00")
a.human("把商品列表缓存改成 5 分钟，然后推到远端"); a.tool("Bash", {"command": "git push origin main"}, minutes=3)
a.save()
b = CC(S, "old", "/demo/api", "2026-10-20T14:55:00")
b.human("给订单接口加分页，然后推到远端"); b.tool("Bash", {"command": "git push origin main"}, minutes=3)
b.save()
inbox_rows = [
    {"tool": "cc", "event": "waiting_permission", "session_id": b.sid, "cwd": b.cwd, "transcript_path": str(b.path.resolve()),
     "at": "2026-10-20T15:00:00.000Z", "detail": "Claude needs your permission to use Bash"},
    {"tool": "cc", "event": "waiting_permission", "session_id": a.sid, "cwd": a.cwd, "transcript_path": str(a.path.resolve()),
     "at": "2026-10-20T17:30:00.000Z", "detail": "Claude needs your permission to use Bash"},
]
wj(OUT / S / "inbox" / "cc.jsonl", inbox_rows)
base = OUT / S / "pi-autoreview"
summary_at(base, "shop", "/demo/shop", "r10-done", "完成", "2026-10-19 10:00:00", [])
summary_at(base, "blog", "/demo/blog", "r10-pause", "暂停（开发方需要你决定）", "2026-10-20 13:40:00", ["开发方问：文章摘要截多少字"])
card(S, "第一次接入（数据目录是空的）。/demo/shop 的 Claude Code 30 分钟前停下等授权；/demo/api 的 Claude Code 3 小时前就停下等授权了；/demo/shop 的 loop 昨天跑完；/demo/blog 的 loop 20 分钟前暂停等你决定。loop 总结里的时间是本机当地时间（10 月 20 日为 UTC-4，13:40 即 17:40Z）",
     "先用 2026-10-20T18:00:00Z 跑一轮，再用 2026-10-20T18:10:00Z 跑一轮",
     "第一轮发件记录正好两条：/demo/shop 的 Claude Code 等授权、/demo/blog 的 loop 暂停；总览里四条都在（/demo/api 显示在等我，loop 昨天那次显示完成）；第二轮不新增发件",
     "第一次用真实数据回放时，一轮就对历史补发了 291 条提醒")

# ===== R11 已搁置：超过 24 小时没动静的不算停滞 =====
S = "R11-已搁置"
c = CC(S, "shelved", "/demo/a", "2026-10-18T09:55:00")
c.human("改 A 页的表单校验"); c.tool("Bash", {"command": "npm test"}, minutes=5)
c.save()
d = CC(S, "stalled", "/demo/b", "2026-10-20T17:15:00")
d.human("改 B 页的表单校验"); d.tool("Bash", {"command": "npm test"}, minutes=5)
d.save()
card(S, "两个干到一半没返回的 Claude Code 会话：/demo/a 最后一次动静在 2026-10-18T10:00Z（两天多以前）；/demo/b 最后一次动静在 2026-10-20T17:20Z（40 分钟前）。数据目录是空的",
     "2026-10-20T18:00:00Z",
     "总览里 /demo/a 是「已搁置」、/demo/b 是「停滞」；发件记录只有一条 /demo/b 的停滞提醒，/demo/a 没有提醒",
     "第一次用真实数据回放时 141 个停滞里 139 个最后动静在一天以前")
print("added")
