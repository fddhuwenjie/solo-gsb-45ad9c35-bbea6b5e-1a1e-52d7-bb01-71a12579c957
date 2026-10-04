"use strict";
/* 前端逻辑冒烟测试：node test_frontend.js（无需浏览器与第三方依赖）。
 * 用最小 DOM 桩加载 static/app.js，验证：
 *  1. 时间码解析 / 格式化；
 *  2. 渲染生成的动态行 ID 与各保存函数读取的 ID 一致；
 *  3. 保存发言区间 / 授权时发出的请求体正确；
 *  4. 校验结果渲染包含时间码与状态。 */
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const elements = new Map();
function el(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, value: "", checked: false, textContent: "", innerHTML: "",
      className: "", style: {},
      classList: { toggle() {} },
      addEventListener() {},
    });
  }
  return elements.get(id);
}

const calls = [];
const sandbox = {
  console,
  document: { getElementById: (id) => el(id) },
  window: { addEventListener: () => {} },
  confirm: () => true,
  fetch: async (path, opts) => {
    calls.push({ path, opts });
    const isGet = !opts || !opts.method || opts.method === "GET";
    return { ok: true, json: async () => (isGet ? sandbox.__test__.state.detail : {}) };
  },
};
vm.createContext(sandbox);
const code = fs.readFileSync("static/app.js", "utf8");
vm.runInContext(
  code + "\nglobalThis.__test__ = { state, render, renderResults, saveSegment, saveLicense, fmt, parseTimecode };",
  sandbox
);
const T = sandbox.__test__;

async function main() {
  // 1. 时间码
  assert.strictEqual(T.parseTimecode("01:00:00"), 3600);
  assert.strictEqual(T.parseTimecode("1:30"), 90);
  assert.strictEqual(T.parseTimecode("90"), 90);
  assert.ok(Number.isNaN(T.parseTimecode("abc")));
  assert.strictEqual(T.fmt(3661), "01:01:01");

  // 2. 渲染与动态 ID 一致性
  T.state.currentId = 1;
  T.state.detail = {
    id: 1, title: "示例", duration_seconds: 3600,
    speakers: [{ id: 1, name: "张三" }, { id: 2, name: "李四" }],
    segments: [{ id: 10, speaker_id: 1, start_seconds: 0, end_seconds: 600 }],
    licenses: [{
      id: 20, speaker_id: 2, start_seconds: 0, end_seconds: 3600,
      allow_media: ["audio"], deny_media: ["text"],
      embargo_until: "2027-01-01", note: "",
    }],
  };
  T.render();
  const segHtml = elements.get("segments-body").innerHTML;
  for (const id of ["seg-10-sp", "seg-10-start", "seg-10-end"]) {
    assert.ok(segHtml.includes(`id="${id}"`), `发言区间缺少 ${id}`);
  }
  const licHtml = elements.get("licenses-body").innerHTML;
  for (const id of ["lic-20-start", "lic-20-end",
    "lic-20-allow-audio", "lic-20-allow-text",
    "lic-20-deny-audio", "lic-20-deny-text",
    "lic-20-emb", "lic-20-note"]) {
    assert.ok(licHtml.includes(`id="${id}"`), `授权行缺少 ${id}`);
  }
  assert.ok(elements.get("speakers-body").innerHTML.includes('id="sp-name-1"'));

  // 3. 保存发言区间 -> 正确的 PUT 请求体
  el("seg-10-sp").value = "2";
  el("seg-10-start").value = "00:01:00";
  el("seg-10-end").value = "00:02:00";
  await T.saveSegment(10);
  const segPut = calls.filter((c) => c.opts && c.opts.method === "PUT").pop();
  assert.deepStrictEqual(JSON.parse(segPut.opts.body),
    { speaker_id: 2, start_seconds: 60, end_seconds: 120 });

  // 4. 保存授权 -> 正确的 PUT 请求体
  el("lic-20-start").value = "00:00:00";
  el("lic-20-end").value = "01:00:00";
  el("lic-20-allow-audio").checked = true;
  el("lic-20-allow-text").checked = false;
  el("lic-20-deny-audio").checked = false;
  el("lic-20-deny-text").checked = true;
  el("lic-20-emb").value = "2027-01-01";
  el("lic-20-note").value = "备注";
  await T.saveLicense(20);
  const licPut = calls.filter((c) => c.opts && c.opts.method === "PUT").pop();
  assert.deepStrictEqual(JSON.parse(licPut.opts.body), {
    start_seconds: 0, end_seconds: 3600,
    allow_media: ["audio"], deny_media: ["text"],
    embargo_until: "2027-01-01", note: "备注",
  });

  // 5. 校验结果渲染
  T.renderResults({
    publication_date: "2026-09-23", medium: "audio",
    summary: { duration_seconds: 3600, publishable_seconds: 3000, blocked_seconds: 600 },
    intervals: [{
      start_seconds: 0, end_seconds: 600,
      start_timecode: "00:00:00", end_timecode: "00:10:00",
      status: "blocked", status_label: "不可发布",
      speakers: ["张三"], reasons: ["张三：缺少覆盖该区间的授权记录（缺项）"],
    }],
  });
  assert.ok(elements.get("results-body").innerHTML.includes("00:00:00 – 00:10:00"));
  assert.ok(elements.get("timeline").innerHTML.includes("blocked"));
  assert.ok(elements.get("results-summary").innerHTML.includes("2026-09-23"));

  console.log("test_frontend.js: 全部通过");
}

main().catch((e) => { console.error(e); process.exit(1); });
