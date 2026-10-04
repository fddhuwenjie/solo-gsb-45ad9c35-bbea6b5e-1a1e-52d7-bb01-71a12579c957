"""补件并复核（POST /api/interviews/<id>/supplement）的端到端测试。

使用 Flask 测试客户端 + 临时 SQLite 数据库，覆盖：
- 批次校验：重叠 / 互相冲突 / 越界 / 空批次 / 非法说话人 -> 整批失败（400）；
- 试算（commit 缺省）：不落库，返回前后对比与变更区间；
- 提交成功：整条时间轴全部可发布 -> 整批一次性写入并列出变更区间；
- 提交失败：合并后仍有阻断 -> 不落任何记录，返回每个阻断区间及原因。
"""
import os
import tempfile
import unittest

_fd, _DB = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.environ["DB_PATH"] = _DB

import app as app_module  # noqa: E402


def supp(sp, start, end, allow=("audio",), deny=(), embargo=None, note=""):
    return {
        "speaker_id": sp,
        "start_seconds": start,
        "end_seconds": end,
        "allow_media": list(allow),
        "deny_media": list(deny),
        "embargo_until": embargo,
        "note": note,
    }


class SupplementApiTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        os.unlink(_DB)

    def setUp(self):
        self.client = app_module.app.test_client()
        db = app_module.sqlite3.connect(_DB)
        db.executescript(
            "DELETE FROM licenses; DELETE FROM segments;"
            " DELETE FROM speakers; DELETE FROM interviews;")
        db.commit()
        db.close()
        # 基础数据：600 秒访谈，甲说 0-300，乙说 300-600；
        # 甲已有 [0,300] 允许音频的授权，乙无授权。
        c = self.client
        self.iid = c.post("/api/interviews", json={
            "title": "访谈", "duration_seconds": 600}).get_json()["id"]
        self.sp1 = c.post(f"/api/interviews/{self.iid}/speakers",
                          json={"name": "甲"}).get_json()["id"]
        self.sp2 = c.post(f"/api/interviews/{self.iid}/speakers",
                          json={"name": "乙"}).get_json()["id"]
        c.post(f"/api/interviews/{self.iid}/segments", json={
            "speaker_id": self.sp1, "start_seconds": 0, "end_seconds": 300})
        c.post(f"/api/interviews/{self.iid}/segments", json={
            "speaker_id": self.sp2, "start_seconds": 300, "end_seconds": 600})
        c.post(f"/api/speakers/{self.sp1}/licenses", json={
            "start_seconds": 0, "end_seconds": 300,
            "allow_media": ["audio"], "deny_media": [],
            "embargo_until": None, "note": ""})

    def license_count(self):
        return len(self.client.get(
            f"/api/interviews/{self.iid}").get_json()["licenses"])

    def post_supplement(self, supplements, commit=None, medium="audio",
                        publication_date="2026-10-04", iid=None):
        body = {"publication_date": publication_date, "medium": medium,
                "supplements": supplements}
        if commit is not None:
            body["commit"] = commit
        return self.client.post(
            f"/api/interviews/{iid if iid is not None else self.iid}/supplement",
            json=body)

    # ---------------------------------------------------------- 试算与提交

    def test_dry_run_never_writes(self):
        resp = self.post_supplement([supp(self.sp2, 300, 600)])
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["publishable"])
        self.assertFalse(data["committed"])
        self.assertEqual(data["created_licenses"], [])
        self.assertEqual(data["before"]["summary"]["blocked_seconds"], 300)
        self.assertEqual(data["after"]["summary"]["blocked_seconds"], 0)
        self.assertEqual(data["changed_intervals"], [{
            "start_seconds": 300, "end_seconds": 600,
            "start_timecode": "00:05:00", "end_timecode": "00:10:00",
            "before_status": "blocked", "after_status": "ok",
            "before_status_label": "不可发布", "after_status_label": "可发布",
        }])
        self.assertEqual(self.license_count(), 1)  # 不落任何记录

    def test_commit_writes_whole_batch_atomically(self):
        resp = self.post_supplement(
            [supp(self.sp2, 300, 450, note="第一段"),
             supp(self.sp2, 450, 600, allow=("audio", "text"))],
            commit=True)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["committed"])
        self.assertEqual(len(data["created_licenses"]), 2)
        ids = [l["id"] for l in data["created_licenses"]]
        self.assertTrue(all(isinstance(i, int) for i in ids))
        self.assertEqual(self.license_count(), 3)  # 原有 1 条 + 整批 2 条
        # 变更区间：300-600 由不可发布变为可发布
        self.assertEqual([(c["start_seconds"], c["end_seconds"],
                           c["before_status"], c["after_status"])
                          for c in data["changed_intervals"]],
                         [(300, 600, "blocked", "ok")])
        # 原有校验接口同步生效
        ev = self.client.post(f"/api/interviews/{self.iid}/evaluate", json={
            "publication_date": "2026-10-04", "medium": "audio"}).get_json()
        self.assertEqual(ev["summary"]["blocked_seconds"], 0)

    def test_commit_blocked_returns_intervals_and_writes_nothing(self):
        # 补件只覆盖乙的 300-450，450-600 仍缺项 -> 整批不落库
        resp = self.post_supplement([supp(self.sp2, 300, 450)], commit=True)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertFalse(data["publishable"])
        self.assertFalse(data["committed"])
        self.assertEqual(data["created_licenses"], [])
        blocked = data["blocked_intervals"]
        self.assertEqual(len(blocked), 1)
        self.assertEqual((blocked[0]["start_seconds"], blocked[0]["end_seconds"]),
                         (450, 600))
        self.assertEqual(blocked[0]["start_timecode"], "00:07:30")
        self.assertTrue(any("缺项" in r and "乙" in r
                            for r in blocked[0]["reasons"]))
        self.assertEqual(self.license_count(), 1)  # 未落任何记录

    def test_conflict_with_existing_license_blocks_commit(self):
        # 甲的既有授权拒绝音频，补件又允许音频 -> 授权冲突，按拒绝优先
        self.client.post(f"/api/speakers/{self.sp1}/licenses", json={
            "start_seconds": 0, "end_seconds": 300,
            "allow_media": [], "deny_media": ["audio"],
            "embargo_until": None, "note": ""})
        resp = self.post_supplement(
            [supp(self.sp1, 0, 300), supp(self.sp2, 300, 600)], commit=True)
        data = resp.get_json()
        self.assertFalse(data["committed"])
        reasons = [r for b in data["blocked_intervals"] for r in b["reasons"]]
        self.assertTrue(any("冲突" in r for r in reasons))
        self.assertEqual(self.license_count(), 2)

    def test_embargoed_supplement_keeps_blocked(self):
        resp = self.post_supplement(
            [supp(self.sp2, 300, 600, embargo="2030-01-01")], commit=True)
        data = resp.get_json()
        self.assertFalse(data["committed"])
        reasons = data["blocked_intervals"][0]["reasons"]
        self.assertTrue(any("未解禁" in r for r in reasons))
        self.assertEqual(self.license_count(), 1)
        # 解禁日当天即可发布
        ok = self.post_supplement(
            [supp(self.sp2, 300, 600, embargo="2030-01-01")],
            commit=True, publication_date="2030-01-01").get_json()
        self.assertTrue(ok["committed"])
        self.assertEqual(self.license_count(), 2)

    def test_multi_speaker_coverage_rule_applies(self):
        # 甲乙在 300-600 同时发言：乙的补件不足以覆盖，甲在该段也缺授权
        c = self.client
        c.post(f"/api/interviews/{self.iid}/segments", json={
            "speaker_id": self.sp1, "start_seconds": 300, "end_seconds": 600})
        resp = self.post_supplement([supp(self.sp2, 300, 600)], commit=True)
        data = resp.get_json()
        self.assertFalse(data["committed"])
        reasons = [r for b in data["blocked_intervals"] for r in b["reasons"]]
        self.assertTrue(any("甲" in r and "缺项" in r for r in reasons))
        self.assertEqual(self.license_count(), 1)

    # ---------------------------------------------------------- 批次校验

    def assert_batch_rejected(self, supplements, keyword):
        resp = self.post_supplement(supplements, commit=True)
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn("error", data)
        self.assertTrue(any(keyword in p for p in data["problems"]),
                        f"problems 中未找到 {keyword}: {data['problems']}")
        self.assertEqual(self.license_count(), 1)

    def test_overlapping_batch_fails(self):
        self.assert_batch_rejected(
            [supp(self.sp2, 300, 500), supp(self.sp2, 400, 600)], "重叠")

    def test_touching_batch_is_not_overlap(self):
        # 半开区间首尾相接不算重叠
        resp = self.post_supplement(
            [supp(self.sp2, 300, 450), supp(self.sp2, 450, 600)], commit=True)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.get_json()["committed"])

    def test_self_conflicting_media_fails(self):
        self.assert_batch_rejected(
            [supp(self.sp2, 300, 600, allow=("audio",), deny=("audio",))],
            "互相冲突")

    def test_out_of_bounds_fails(self):
        self.assert_batch_rejected([supp(self.sp2, 300, 601)], "越界")
        self.assert_batch_rejected([supp(self.sp2, -1, 600)], "越界")

    def test_empty_batch_fails(self):
        resp = self.post_supplement([], commit=True)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("不能为空", resp.get_json()["error"])

    def test_unknown_speaker_fails(self):
        self.assert_batch_rejected([supp(9999, 300, 600)], "说话人")

    def test_bad_medium_and_date_fail(self):
        resp = self.post_supplement([supp(self.sp2, 300, 600)], medium="video")
        self.assertEqual(resp.status_code, 400)
        resp = self.post_supplement([supp(self.sp2, 300, 600)],
                                    publication_date="")
        self.assertEqual(resp.status_code, 400)
        resp = self.post_supplement([supp(self.sp2, 300, 600)],
                                    publication_date="2026-13-01")
        self.assertEqual(resp.status_code, 400)

    def test_interview_not_found(self):
        resp = self.post_supplement([supp(self.sp2, 300, 600)], iid=9999)
        self.assertEqual(resp.status_code, 404)


class DiffIntervalsTest(unittest.TestCase):
    def test_adjacent_same_change_merges(self):
        from supplement import diff_intervals
        before = [{"start_seconds": 0, "end_seconds": 300, "status": "blocked"},
                  {"start_seconds": 300, "end_seconds": 600, "status": "blocked"}]
        after = [{"start_seconds": 0, "end_seconds": 600, "status": "ok"}]
        changes = diff_intervals(before, after)
        self.assertEqual(len(changes), 1)
        self.assertEqual((changes[0]["start_seconds"], changes[0]["end_seconds"]),
                         (0, 600))
        self.assertEqual(changes[0]["before_status_label"], "不可发布")
        self.assertEqual(changes[0]["after_status_label"], "可发布")

    def test_no_change(self):
        from supplement import diff_intervals
        timeline = [{"start_seconds": 0, "end_seconds": 600, "status": "ok"}]
        self.assertEqual(diff_intervals(timeline, timeline), [])


if __name__ == "__main__":
    unittest.main()
