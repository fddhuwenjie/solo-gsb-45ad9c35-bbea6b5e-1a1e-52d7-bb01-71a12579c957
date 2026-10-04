"use strict";

/* 口述史发布许可校验台 —— 前端交互（原生 JavaScript） */

const MEDIA = [
  { value: "audio", label: "音频" },
  { value: "text", label: "文字" },
];

const state = {
  interviews: [],
  currentId: null,
  detail: null, // {id, title, duration_seconds, speakers, segments, licenses}
  batch: [],    // 补件批次（未提交的编辑行）
};

const $ = (id) => document.getElementById(id);

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmt(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function parseTimecode(str) {
  str = String(str ?? "").trim();
  if (!str) return NaN;
  const parts = str.split(":");
  if (parts.length > 3) return NaN;
  let sec = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return NaN;
    sec = sec * 60 + parseInt(p, 10);
  }
  return sec;
}

function setStatus(msg, isError = false) {
  const el = $("status-line");
  el.textContent = msg || "";
  el.className = isError ? "error" : "";
}

async function api(path, method = "GET", body) {
  let resp;
  try {
    resp = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("无法连接服务器");
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败（HTTP ${resp.status}）`);
  return data;
}

/* 包装异步操作，统一错误提示 */
async function run(fn) {
  try {
    await fn();
    setStatus("");
  } catch (e) {
    setStatus(e.message, true);
  }
}

/* ---------- 数据加载 ---------- */

async function loadInterviews() {
  state.interviews = await api("/api/interviews");
  if (!state.interviews.some((i) => i.id === state.currentId)) {
    state.currentId = state.interviews.length ? state.interviews[0].id : null;
  }
  await refreshDetail();
  render();
}

async function refreshDetail() {
  state.detail = state.currentId
    ? await api(`/api/interviews/${state.currentId}`)
    : null;
}

/* ---------- 渲染 ---------- */

function render() {
  const sel = $("interview-select");
  sel.innerHTML = state.interviews.length
    ? state.interviews.map((i) =>
        `<option value="${i.id}" ${i.id === state.currentId ? "selected" : ""}>`
        + `#${i.id} ${esc(i.title)}（${fmt(i.duration_seconds)}）</option>`).join("")
    : `<option value="">（暂无访谈，请先新建）</option>`;

  const has = !!state.detail;
  $("detail-panels").classList.toggle("hidden", !has);
  $("interview-edit").classList.toggle("hidden", !has);
  if (!has) return;

  $("edit-title").value = state.detail.title;
  $("edit-duration").value = fmt(state.detail.duration_seconds);
  renderSpeakers();
  renderSegments();
  renderLicenses();
  captureBatch();
  renderBatch();
}

function speakerOptions(selected) {
  return state.detail.speakers.map((s) =>
    `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${esc(s.name)}</option>`
  ).join("");
}

function speakerName(id) {
  const sp = state.detail.speakers.find((s) => s.id === id);
  return sp ? sp.name : `#${id}`;
}

function renderSpeakers() {
  const rows = state.detail.speakers.map((s) => `
    <tr>
      <td>#${s.id}</td>
      <td><input id="sp-name-${s.id}" value="${esc(s.name)}"></td>
      <td>
        <button onclick="run(() => saveSpeaker(${s.id}))">保存</button>
        <button class="danger" onclick="run(() => delSpeaker(${s.id}))">删除</button>
      </td>
    </tr>`).join("");
  $("speakers-body").innerHTML =
    rows || `<tr><td colspan="3" class="empty">暂无说话人</td></tr>`;
}

function renderSegments() {
  const rows = state.detail.segments.map((g) => `
    <tr>
      <td>#${g.id}</td>
      <td><select id="seg-${g.id}-sp">${speakerOptions(g.speaker_id)}</select></td>
      <td><input id="seg-${g.id}-start" class="tc-input" value="${fmt(g.start_seconds)}"></td>
      <td><input id="seg-${g.id}-end" class="tc-input" value="${fmt(g.end_seconds)}"></td>
      <td>
        <button onclick="run(() => saveSegment(${g.id}))">保存</button>
        <button class="danger" onclick="run(() => delSegment(${g.id}))">删除</button>
      </td>
    </tr>`).join("");
  $("segments-body").innerHTML =
    rows || `<tr><td colspan="5" class="empty">暂无发言区间</td></tr>`;
  $("new-seg-speaker").innerHTML = speakerOptions(null);
}

function mediaCheckboxes(prefix, picked) {
  return MEDIA.map((m) =>
    `<label><input type="checkbox" id="${prefix}-${m.value}"`
    + `${picked.includes(m.value) ? " checked" : ""}>${m.label}</label>`
  ).join("");
}

function readMediaCheckboxes(prefix) {
  return MEDIA.filter((m) => $(`${prefix}-${m.value}`).checked)
    .map((m) => m.value);
}

function renderLicenses() {
  const rows = state.detail.licenses.map((l) => `
    <tr>
      <td>#${l.id}</td>
      <td>${esc(speakerName(l.speaker_id))}</td>
      <td><input id="lic-${l.id}-start" class="tc-input" value="${fmt(l.start_seconds)}"></td>
      <td><input id="lic-${l.id}-end" class="tc-input" value="${fmt(l.end_seconds)}"></td>
      <td>${mediaCheckboxes(`lic-${l.id}-allow`, l.allow_media)}</td>
      <td>${mediaCheckboxes(`lic-${l.id}-deny`, l.deny_media)}</td>
      <td><input type="date" id="lic-${l.id}-emb" value="${esc(l.embargo_until || "")}"></td>
      <td><input id="lic-${l.id}-note" value="${esc(l.note)}"></td>
      <td>
        <button onclick="run(() => saveLicense(${l.id}))">保存</button>
        <button class="danger" onclick="run(() => delLicense(${l.id}))">删除</button>
      </td>
    </tr>`).join("");
  $("licenses-body").innerHTML =
    rows || `<tr><td colspan="9" class="empty">暂无授权记录</td></tr>`;
  $("new-lic-speaker").innerHTML = speakerOptions(null);
}

function clearResults() {
  $("results-summary").textContent = "尚未校验。";
  $("timeline").innerHTML = "";
  $("results-body").innerHTML = "";
}

function timelineHtml(intervals, duration) {
  return intervals.map((it) => {
    const width = (it.end_seconds - it.start_seconds) / duration * 100;
    const tip = `${it.start_timecode}–${it.end_timecode} ${it.status_label}`
      + (it.reasons.length ? "\n" + it.reasons.join("\n") : "");
    return `<div class="seg ${it.status}" style="width:${width}%"`
      + ` title="${esc(tip)}"></div>`;
  }).join("");
}

function renderResults(data) {
  const { intervals, summary } = data;
  const mediumLabel = data.medium === "audio" ? "音频" : "文字";
  $("results-summary").innerHTML =
    `发布日期 <b>${esc(data.publication_date)}</b> · 媒介 <b>${mediumLabel}</b> · `
    + `总时长 <b>${fmt(summary.duration_seconds)}</b>，`
    + `可发布 <b class="ok-text">${fmt(summary.publishable_seconds)}</b>，`
    + `不可发布 <b class="bad-text">${fmt(summary.blocked_seconds)}</b>`;

  $("timeline").innerHTML = timelineHtml(intervals, summary.duration_seconds);

  $("results-body").innerHTML = intervals.map((it) => `
    <tr class="${it.status}">
      <td class="tc">${it.start_timecode} – ${it.end_timecode}</td>
      <td>${fmt(it.end_seconds - it.start_seconds)}</td>
      <td><span class="badge ${it.status}">${it.status_label}</span></td>
      <td>${it.speakers.length ? esc(it.speakers.join("、")) : "—"}</td>
      <td>${it.reasons.length
        ? it.reasons.map(esc).join("<br>")
        : (it.status === "no_speech" ? "无发言，无需授权" : "全部发言人授权有效")}</td>
    </tr>`).join("");
}

/* ---------- 访谈操作 ---------- */

async function createInterview() {
  const title = $("new-title").value.trim();
  const duration_seconds = parseTimecode($("new-duration").value);
  if (!title) throw new Error("请填写访谈标题");
  if (!Number.isInteger(duration_seconds) || duration_seconds <= 0) {
    throw new Error("时长格式应为 HH:MM:SS");
  }
  const created = await api("/api/interviews", "POST", { title, duration_seconds });
  state.currentId = created.id;
  $("new-title").value = "";
  await loadInterviews();
}

async function saveInterview() {
  const title = $("edit-title").value.trim();
  const duration_seconds = parseTimecode($("edit-duration").value);
  if (!title) throw new Error("请填写访谈标题");
  if (!Number.isInteger(duration_seconds) || duration_seconds <= 0) {
    throw new Error("时长格式应为 HH:MM:SS");
  }
  await api(`/api/interviews/${state.currentId}`, "PUT", { title, duration_seconds });
  await loadInterviews();
}

async function deleteInterview() {
  if (!confirm("确定删除该访谈及其全部说话人、发言与授权记录？")) return;
  await api(`/api/interviews/${state.currentId}`, "DELETE");
  state.currentId = null;
  clearResults();
  clearSupplement();
  await loadInterviews();
}

/* ---------- 说话人操作 ---------- */

async function addSpeaker() {
  const name = $("new-speaker-name").value.trim();
  if (!name) throw new Error("请填写说话人姓名");
  await api(`/api/interviews/${state.currentId}/speakers`, "POST", { name });
  $("new-speaker-name").value = "";
  await refreshDetail();
  render();
}

async function saveSpeaker(id) {
  const name = $(`sp-name-${id}`).value.trim();
  if (!name) throw new Error("说话人姓名不能为空");
  await api(`/api/speakers/${id}`, "PUT", { name });
  await refreshDetail();
  render();
}

async function delSpeaker(id) {
  if (!confirm("删除该说话人及其发言、授权记录？")) return;
  await api(`/api/speakers/${id}`, "DELETE");
  await refreshDetail();
  render();
}

/* ---------- 发言区间操作 ---------- */

function readSegmentInputs(prefix) {
  const start_seconds = parseTimecode($(`${prefix}-start`).value);
  const end_seconds = parseTimecode($(`${prefix}-end`).value);
  if (!Number.isInteger(start_seconds) || !Number.isInteger(end_seconds)) {
    throw new Error("时间码格式应为 HH:MM:SS");
  }
  if (end_seconds <= start_seconds) throw new Error("结束时间必须大于开始时间");
  return { start_seconds, end_seconds };
}

async function addSegment() {
  const speaker_id = Number($("new-seg-speaker").value);
  if (!speaker_id) throw new Error("请先添加说话人");
  const range = readSegmentInputs("new-seg");
  await api(`/api/interviews/${state.currentId}/segments`, "POST",
    { speaker_id, ...range });
  await refreshDetail();
  render();
}

async function saveSegment(id) {
  const speaker_id = Number($(`seg-${id}-sp`).value);
  const range = readSegmentInputs(`seg-${id}`);
  await api(`/api/segments/${id}`, "PUT", { speaker_id, ...range });
  await refreshDetail();
  render();
}

async function delSegment(id) {
  await api(`/api/segments/${id}`, "DELETE");
  await refreshDetail();
  render();
}

/* ---------- 授权区间操作 ---------- */

function readLicenseInputs(prefix) {
  const range = readSegmentInputs(prefix);
  return {
    ...range,
    allow_media: readMediaCheckboxes(`${prefix}-allow`),
    deny_media: readMediaCheckboxes(`${prefix}-deny`),
    embargo_until: $(`${prefix}-emb`).value || null,
    note: $(`${prefix}-note`).value.trim(),
  };
}

async function addLicense() {
  const speaker_id = Number($("new-lic-speaker").value);
  if (!speaker_id) throw new Error("请先添加说话人");
  const values = readLicenseInputs("new-lic");
  await api(`/api/speakers/${speaker_id}/licenses`, "POST", values);
  await refreshDetail();
  render();
}

async function saveLicense(id) {
  const values = readLicenseInputs(`lic-${id}`);
  await api(`/api/licenses/${id}`, "PUT", values);
  await refreshDetail();
  render();
}

async function delLicense(id) {
  await api(`/api/licenses/${id}`, "DELETE");
  await refreshDetail();
  render();
}

/* ---------- 校验 ---------- */

async function evaluate() {
  const publication_date = $("pub-date").value;
  const medium = $("medium").value;
  if (!publication_date) throw new Error("请选择发布日期");
  const data = await api(`/api/interviews/${state.currentId}/evaluate`, "POST",
    { publication_date, medium });
  renderResults(data);
}

/* ---------- 补件并复核 ---------- */

function emptyBatchRow() {
  const first = state.detail && state.detail.speakers[0];
  return {
    speaker_id: first ? first.id : null,
    start: "00:00:00",
    end: state.detail ? fmt(state.detail.duration_seconds) : "00:00:00",
    allow: ["audio"],
    deny: [],
    embargo: "",
    note: "",
  };
}

/* 把页面上未保存的补件行读回 state.batch（重新渲染前调用） */
function captureBatch() {
  state.batch.forEach((row, i) => {
    const sp = $(`supp-${i}-sp`);
    if (!sp || !$(`supp-${i}-start`)) return;
    row.speaker_id = Number(sp.value) || null;
    row.start = $(`supp-${i}-start`).value;
    row.end = $(`supp-${i}-end`).value;
    row.allow = readMediaCheckboxes(`supp-${i}-allow`);
    row.deny = readMediaCheckboxes(`supp-${i}-deny`);
    row.embargo = $(`supp-${i}-emb`).value;
    row.note = $(`supp-${i}-note`).value;
  });
}

function renderBatch() {
  const rows = state.batch.map((row, i) => `
    <tr>
      <td>补${i + 1}</td>
      <td><select id="supp-${i}-sp">${speakerOptions(row.speaker_id)}</select></td>
      <td><input id="supp-${i}-start" class="tc-input" value="${esc(row.start)}"></td>
      <td><input id="supp-${i}-end" class="tc-input" value="${esc(row.end)}"></td>
      <td>${mediaCheckboxes(`supp-${i}-allow`, row.allow)}</td>
      <td>${mediaCheckboxes(`supp-${i}-deny`, row.deny)}</td>
      <td><input type="date" id="supp-${i}-emb" value="${esc(row.embargo)}"></td>
      <td><input id="supp-${i}-note" value="${esc(row.note)}"></td>
      <td><button class="danger" onclick="run(() => delBatchRow(${i}))">删除</button></td>
    </tr>`).join("");
  $("supp-body").innerHTML = rows
    || `<tr><td colspan="9" class="empty">暂无补件，点击下方「添加补件行」</td></tr>`;
}

async function addBatchRow() {
  captureBatch();
  state.batch.push(emptyBatchRow());
  renderBatch();
}

async function delBatchRow(i) {
  captureBatch();
  state.batch.splice(i, 1);
  renderBatch();
}

function clearSupplement() {
  state.batch = [];
  renderBatch();
  $("supp-result").innerHTML = "";
}

function readBatchPayload() {
  captureBatch();
  if (!state.batch.length) throw new Error("请先添加补件行");
  return state.batch.map((row, i) => {
    if (!row.speaker_id) throw new Error(`补${i + 1}：请选择说话人`);
    const start_seconds = parseTimecode(row.start);
    const end_seconds = parseTimecode(row.end);
    if (!Number.isInteger(start_seconds) || !Number.isInteger(end_seconds)) {
      throw new Error(`补${i + 1}：时间码格式应为 HH:MM:SS`);
    }
    return {
      speaker_id: row.speaker_id,
      start_seconds,
      end_seconds,
      allow_media: row.allow,
      deny_media: row.deny,
      embargo_until: row.embargo || null,
      note: row.note.trim(),
    };
  });
}

async function submitSupplement(commit) {
  const publication_date = $("pub-date").value;
  const medium = $("medium").value;
  if (!publication_date) throw new Error("请选择发布日期");
  const supplements = readBatchPayload();
  if (commit
      && !confirm("确认提交整批补件？仅当合并后整条时间轴全部可发布时才会一次性写入。")) {
    return;
  }
  const data = await api(`/api/interviews/${state.currentId}/supplement`, "POST",
    { publication_date, medium, supplements, commit });
  if (data.committed) {
    state.batch = [];
    await refreshDetail();
    render();
  }
  renderSupplementResult(data);
}

function renderSupplementResult(data) {
  const mediumLabel = data.medium === "audio" ? "音频" : "文字";
  const created = data.created_licenses || [];
  const head = data.committed
    ? `<p class="supp-verdict ok-text">已一次性写入 ${created.length} 条补件授权`
      + `（许可 ${created.map((l) => "#" + l.id).join("、")}），`
      + `变更区间见下。</p>`
    : data.publishable
      ? `<p class="supp-verdict ok-text">试算通过：合并补件后整条时间轴`
        + `全部可发布（未写入，可点击「补件并复核」落库）。</p>`
      : `<p class="supp-verdict bad-text">`
        + `${data.commit ? "复核未通过" : "试算未通过"}：仍有 `
        + `${data.blocked_intervals.length} 个阻断区间，未落任何记录。</p>`;

  const changed = data.changed_intervals || [];
  const changedHtml = changed.length ? `
    <h3>变更区间（${changed.length}）</h3>
    <table>
      <thead><tr><th>区间（时间码）</th><th>变更前</th><th>变更后</th></tr></thead>
      <tbody>${changed.map((c) => `
        <tr>
          <td class="tc">${c.start_timecode} – ${c.end_timecode}</td>
          <td><span class="badge ${c.before_status}">${c.before_status_label}</span></td>
          <td><span class="badge ${c.after_status}">${c.after_status_label}</span></td>
        </tr>`).join("")}</tbody>
    </table>` : "";

  const blocked = data.blocked_intervals || [];
  const blockedHtml = blocked.length ? `
    <h3>阻断区间（${blocked.length}）</h3>
    <table>
      <thead><tr><th>区间（时间码）</th><th>说话人</th><th>原因</th></tr></thead>
      <tbody>${blocked.map((it) => `
        <tr class="blocked">
          <td class="tc">${it.start_timecode} – ${it.end_timecode}</td>
          <td>${it.speakers.length ? esc(it.speakers.join("、")) : "—"}</td>
          <td>${it.reasons.map(esc).join("<br>")}</td>
        </tr>`).join("")}</tbody>
    </table>` : "";

  const s = data.after.summary;
  $("supp-result").innerHTML = `
    <hr>
    ${head}
    <p class="hint">发布日期 ${esc(data.publication_date)} · 媒介 ${mediumLabel} ·
      合并补件后：可发布 ${fmt(s.publishable_seconds)}，
      不可发布 ${fmt(s.blocked_seconds)}
      （补件前不可发布 ${fmt(data.before.summary.blocked_seconds)}）</p>
    <div class="timeline">${timelineHtml(data.after.intervals,
      s.duration_seconds)}</div>
    ${changedHtml}
    ${blockedHtml}`;
}

/* ---------- 启动 ---------- */

window.addEventListener("DOMContentLoaded", () => {
  $("pub-date").value = new Date().toISOString().slice(0, 10);
  $("btn-create-interview").addEventListener("click", () => run(createInterview));
  $("btn-save-interview").addEventListener("click", () => run(saveInterview));
  $("btn-delete-interview").addEventListener("click", () => run(deleteInterview));
  $("btn-refresh").addEventListener("click", () => run(loadInterviews));
  $("btn-add-speaker").addEventListener("click", () => run(addSpeaker));
  $("btn-add-segment").addEventListener("click", () => run(addSegment));
  $("btn-add-license").addEventListener("click", () => run(addLicense));
  $("btn-evaluate").addEventListener("click", () => run(evaluate));
  $("btn-supp-add").addEventListener("click", () => run(addBatchRow));
  $("btn-supp-dry").addEventListener("click", () => run(() => submitSupplement(false)));
  $("btn-supp-commit").addEventListener("click", () => run(() => submitSupplement(true)));
  $("interview-select").addEventListener("change", (e) => run(async () => {
    state.currentId = Number(e.target.value) || null;
    await refreshDetail();
    render();
    clearResults();
    clearSupplement();
  }));
  run(loadInterviews);
});
