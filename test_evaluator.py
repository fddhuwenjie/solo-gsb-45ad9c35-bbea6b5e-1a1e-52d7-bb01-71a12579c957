"""evaluator 核心校验逻辑的单元测试（不依赖 Flask，可直接运行）。"""
import unittest

from evaluator import evaluate_timeline


def lic(lic_id, sp, start, end, allow=(), deny=(), embargo=None):
    return {
        "id": lic_id,
        "speaker_id": sp,
        "start_seconds": start,
        "end_seconds": end,
        "allow_media": list(allow),
        "deny_media": list(deny),
        "embargo_until": embargo,
    }


def seg(sp, start, end):
    return {"speaker_id": sp, "start_seconds": start, "end_seconds": end}


class EvaluateTimelineTest(unittest.TestCase):
    def test_missing_license_blocks(self):
        res = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 600)], [], "2026-09-23", "audio")
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["status"], "blocked")
        self.assertFalse(res[0]["publishable"])
        self.assertIn("缺项", res[0]["reasons"][0])

    def test_all_ok(self):
        res = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 600)],
            [lic(1, 1, 0, 600, allow=["audio"])], "2026-09-23", "audio")
        self.assertEqual(res[0]["status"], "ok")
        self.assertTrue(res[0]["publishable"])
        self.assertEqual(res[0]["reasons"], [])

    def test_deny_priority(self):
        res = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 600)],
            [lic(1, 1, 0, 600, deny=["audio"])], "2026-09-23", "audio")
        self.assertEqual(res[0]["status"], "blocked")
        self.assertIn("拒绝", res[0]["reasons"][0])

    def test_conflict_allow_and_deny(self):
        res = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 600)],
            [lic(1, 1, 0, 600, allow=["audio"]),
             lic(2, 1, 0, 600, deny=["audio"])],
            "2026-09-23", "audio")
        self.assertEqual(res[0]["status"], "blocked")
        self.assertIn("冲突", res[0]["reasons"][0])
        self.assertIn("拒绝优先", res[0]["reasons"][0])

    def test_medium_not_covered_is_missing(self):
        res = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 600)],
            [lic(1, 1, 0, 600, allow=["audio"])], "2026-09-23", "text")
        self.assertEqual(res[0]["status"], "blocked")
        self.assertIn("缺项", res[0]["reasons"][0])

    def test_embargo_not_lifted(self):
        licenses = [lic(1, 1, 0, 600, allow=["audio"], embargo="2030-01-01")]
        blocked = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 600)], licenses, "2026-09-23", "audio")
        self.assertEqual(blocked[0]["status"], "blocked")
        self.assertIn("未解禁", blocked[0]["reasons"][0])
        # 解禁日当天即可发布
        released = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 600)], licenses, "2030-01-01", "audio")
        self.assertEqual(released[0]["status"], "ok")

    def test_boundary_split_by_license(self):
        # 授权只覆盖前半段 -> 前半可发布，后半缺项
        res = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 600)],
            [lic(1, 1, 0, 300, allow=["audio"])], "2026-09-23", "audio")
        self.assertEqual([(r["start_seconds"], r["end_seconds"], r["status"])
                          for r in res],
                         [(0, 300, "ok"), (300, 600, "blocked")])

    def test_no_speech_interval(self):
        res = evaluate_timeline(
            600, {1: "甲"}, [seg(1, 0, 300)],
            [lic(1, 1, 0, 300, allow=["audio"])], "2026-09-23", "audio")
        self.assertEqual(res[-1]["status"], "no_speech")
        self.assertTrue(res[-1]["publishable"])
        self.assertEqual((res[-1]["start_seconds"], res[-1]["end_seconds"]),
                         (300, 600))

    def test_merge_adjacent_same_result(self):
        # 两个说话人相邻发言、授权均有效 -> 合并为一个可发布区间
        res = evaluate_timeline(
            600, {1: "甲", 2: "乙"},
            [seg(1, 0, 300), seg(2, 300, 600)],
            [lic(1, 1, 0, 600, allow=["audio"]),
             lic(2, 2, 0, 600, allow=["audio"])],
            "2026-09-23", "audio")
        self.assertEqual(len(res), 1)
        self.assertEqual((res[0]["start_seconds"], res[0]["end_seconds"]),
                         (0, 600))
        self.assertEqual(res[0]["speakers"], ["甲", "乙"])

    def test_no_merge_when_reasons_differ(self):
        # 相邻区间原因不同 -> 不合并
        res = evaluate_timeline(
            600, {1: "甲", 2: "乙"},
            [seg(1, 0, 300), seg(2, 300, 600)],
            [lic(1, 1, 0, 300, deny=["audio"])],  # 乙完全无授权
            "2026-09-23", "audio")
        self.assertEqual(len(res), 2)
        self.assertTrue(all(r["status"] == "blocked" for r in res))
        self.assertIn("拒绝", res[0]["reasons"][0])
        self.assertIn("缺项", res[1]["reasons"][0])

    def test_multi_speaker_overlap_all_must_be_covered(self):
        # 重叠发言：两人都须有有效授权，缺一人即不可发布
        res = evaluate_timeline(
            600, {1: "甲", 2: "乙"},
            [seg(1, 0, 600), seg(2, 300, 600)],
            [lic(1, 1, 0, 600, allow=["audio"]),
             lic(2, 2, 0, 600, allow=["audio"])],
            "2026-09-23", "audio")
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["status"], "ok")
        # 乙的授权只到 450 -> 450-600 缺乙授权
        res2 = evaluate_timeline(
            600, {1: "甲", 2: "乙"},
            [seg(1, 0, 600), seg(2, 300, 600)],
            [lic(1, 1, 0, 600, allow=["audio"]),
             lic(2, 2, 0, 450, allow=["audio"])],
            "2026-09-23", "audio")
        tail = [r for r in res2 if r["start_seconds"] == 450][0]
        self.assertEqual(tail["status"], "blocked")
        self.assertTrue(any("乙" in r and "缺项" in r for r in tail["reasons"]))

    def test_timecode_format(self):
        res = evaluate_timeline(
            3661, {1: "甲"}, [seg(1, 0, 3661)],
            [lic(1, 1, 0, 3661, allow=["text"])], "2026-09-23", "text")
        self.assertEqual(res[0]["start_timecode"], "00:00:00")
        self.assertEqual(res[0]["end_timecode"], "01:01:01")


if __name__ == "__main__":
    unittest.main()
