"""补件并复核：批量补充授权的校验、合并与前后对比（纯逻辑，不依赖 Flask）。

补件是一批复式授权记录（说话人 + 半开时间区间 + 允许/拒绝媒介 + 解禁日期）。
本模块负责：
1. 校验整批补件 —— 重叠、互相冲突或越界的补件令整批失败；
2. 对比合并补件前后的两次校验结果，列出状态发生变化的区间。
"""
from datetime import date

from evaluator import MEDIA_LABELS, STATUS_LABELS, format_timecode

MEDIA = tuple(MEDIA_LABELS.keys())


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_iso_date(value):
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _media_list(value):
    """去重后的合法媒介列表；非法返回 None。"""
    if value is None:
        return []
    if not isinstance(value, list):
        return None
    result = []
    for item in value:
        if item not in MEDIA:
            return None
        if item not in result:
            result.append(item)
    return result


def validate_supplements(raw, speaker_names, duration):
    """校验一批补件，返回 (cleaned, problems)。

    参数:
        raw: 请求体中的补件列表。
        speaker_names: {speaker_id: 姓名}（仅限本访谈的说话人）。
        duration: 访谈总时长（秒）。

    返回:
        cleaned: [{"id": "补1", "speaker_id", "start_seconds", "end_seconds",
                   "allow_media", "deny_media", "embargo_until", "note"}, ...]
                 id 为试算期间使用的临时编号，便于在原因文案中引用。
        problems: [错误消息, ...]；非空表示整批失败，不得写入任何记录。
    """
    if not isinstance(raw, list) or not raw:
        return [], ["补件批次不能为空"]

    problems = []
    cleaned = []
    for index, item in enumerate(raw, start=1):
        temp_id = f"补{index}"
        if not isinstance(item, dict):
            problems.append(f"{temp_id}：补件格式应为对象")
            continue
        speaker_id = item.get("speaker_id")
        if not _is_int(speaker_id) or speaker_id not in speaker_names:
            problems.append(f"{temp_id}：说话人不存在或不属于该访谈")
            continue
        start = item.get("start_seconds")
        end = item.get("end_seconds")
        if not _is_int(start) or not _is_int(end):
            problems.append(f"{temp_id}：开始与结束时间必须为整数秒")
            continue
        if start < 0:
            problems.append(f"{temp_id}：开始时间不能为负（越界）")
            continue
        if end <= start:
            problems.append(
                f"{temp_id}：结束时间必须大于开始时间（半开区间）")
            continue
        if end > duration:
            problems.append(
                f"{temp_id}：结束时间 {format_timecode(end)} 超出访谈时长"
                f" {format_timecode(duration)}（越界）")
            continue
        allow = _media_list(item.get("allow_media"))
        deny = _media_list(item.get("deny_media"))
        if allow is None or deny is None:
            problems.append(f"{temp_id}：媒介取值仅限 audio（音频）/ text（文字）")
            continue
        both = [m for m in allow if m in deny]
        if both:
            names = "、".join(MEDIA_LABELS[m] for m in both)
            problems.append(f"{temp_id}：同一补件既允许又拒绝{names}（互相冲突）")
            continue
        embargo = item.get("embargo_until")
        if embargo in (None, ""):
            embargo = None
        elif not isinstance(embargo, str) or not _is_iso_date(embargo):
            problems.append(f"{temp_id}：解禁日期格式应为 YYYY-MM-DD")
            continue
        cleaned.append({
            "id": temp_id,
            "speaker_id": speaker_id,
            "start_seconds": start,
            "end_seconds": end,
            "allow_media": allow,
            "deny_media": deny,
            "embargo_until": embargo,
            "note": str(item.get("note") or "").strip(),
        })

    # 同一说话人的补件区间（半开）不得互相重叠
    by_speaker = {}
    for entry in cleaned:
        by_speaker.setdefault(entry["speaker_id"], []).append(entry)
    for sp_id, items in by_speaker.items():
        items.sort(key=lambda c: (c["start_seconds"], c["end_seconds"]))
        for prev, cur in zip(items, items[1:]):
            if cur["start_seconds"] < prev["end_seconds"]:
                name = speaker_names.get(sp_id, f"说话人#{sp_id}")
                problems.append(
                    f"{name}：{prev['id']} 与 {cur['id']} 时间区间重叠"
                    f"（{format_timecode(prev['start_seconds'])}–"
                    f"{format_timecode(prev['end_seconds'])} 与 "
                    f"{format_timecode(cur['start_seconds'])}–"
                    f"{format_timecode(cur['end_seconds'])}），整批失败")
    return cleaned, problems


def merge_licenses(current, cleaned):
    """把整批补件合并到当前授权的副本上，返回新的授权列表（不改动入参）。"""
    return [dict(c) for c in current] + [dict(c) for c in cleaned]


def _status_at(intervals, start, end):
    for it in intervals:
        if it["start_seconds"] <= start and it["end_seconds"] >= end:
            return it["status"]
    return None


def diff_intervals(before, after):
    """对比合并补件前后的两次校验结果，列出状态发生变化的区间。

    前后两份结果都是 [0, duration] 的连续划分；取两边边界的并集切片，
    状态不同的切片按（原状态 -> 新状态）相邻合并。

    返回: [{"start_seconds", "end_seconds", "start_timecode", "end_timecode",
            "before_status", "after_status",
            "before_status_label", "after_status_label"}, ...]
    """
    boundaries = sorted(
        {p for it in before + after
         for p in (it["start_seconds"], it["end_seconds"])})
    changes = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        b = _status_at(before, start, end)
        a = _status_at(after, start, end)
        if a == b:
            continue
        if (changes and changes[-1]["end_seconds"] == start
                and changes[-1]["before_status"] == b
                and changes[-1]["after_status"] == a):
            changes[-1]["end_seconds"] = end
        else:
            changes.append({
                "start_seconds": start,
                "end_seconds": end,
                "before_status": b,
                "after_status": a,
            })
    for c in changes:
        c["start_timecode"] = format_timecode(c["start_seconds"])
        c["end_timecode"] = format_timecode(c["end_seconds"])
        c["before_status_label"] = STATUS_LABELS.get(c["before_status"], "—")
        c["after_status_label"] = STATUS_LABELS.get(c["after_status"], "—")
    return changes
