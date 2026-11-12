'use strict';
const $ = (id) => document.getElementById(id);
let state = {
  workflows: [],
  workers: [],
  runs: [],
  drafts: { flows: [] },
  settings: null,
  view: 'overview',
  runId: null,
};
const names = {
  overview: 'Tổng quan',
  workflows: 'Workflows',
  runs: 'Lịch sử chạy',
  workers: 'Workers',
  settings: 'Cấu hình',
};
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const array = (value, key) => (Array.isArray(value) ? value : (value?.[key] ?? value?.items ?? []));
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s || 'unknown')}</span>`;
const empty = (title, text) =>
  `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;
const time = (v) =>
  v ? new Date(typeof v === 'number' ? v : Date.parse(v)).toLocaleString('vi-VN') : '—';
function notice(message, error = false) {
  $('notice').hidden = false;
  $('notice').className = error ? 'error' : '';
  $('notice').textContent = message;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => ($('notice').hidden = true), 9000);
}
async function api(url, options = {}) {
  const r = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  let data;
  try {
    data = await r.json();
  } catch {
    data = {};
  }
  if (!r.ok) {
    if (r.status === 401) {
      $('shell').hidden = true;
      $('login').hidden = false;
    }
    throw new Error(data.error || data.message || `HTTP ${r.status}`);
  }
  return data;
}
function post(url, body) {
  return api(url, { method: 'POST', body: JSON.stringify(body) });
}
function definition(w) {
  return w.definition ?? w.graph ?? w;
}
function show(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((s) => (s.hidden = s.id !== view));
  document
    .querySelectorAll('nav button')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('page-label').textContent = names[view];
  if (view === 'settings' && !state.settings) refresh();
}
function table(headers, rows) {
  return `<table class="table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function runRows(runs) {
  return runs.map(
    (r) =>
      `<tr><td><strong>${esc(r.workflowName ?? r.workflowId)}</strong><span class="id">${esc(r.id)}</span></td><td>${badge(r.state ?? r.status)}</td><td>${esc(time(r.createdAt ?? r.startedAt))}</td><td><button data-run="${esc(r.id)}">Xem trace →</button></td></tr>`,
  );
}
function workerRows(workers, compact = false) {
  return workers.map(
    (w) =>
      `<tr><td><strong>${esc(w.name ?? w.id ?? w.workerId)}</strong><span class="id">${esc(w.id ?? w.workerId)}</span></td><td>${badge(w.status ?? (w.busy || w.attemptId ? 'busy' : w.online === false ? 'offline' : 'online'))}</td><td>${esc(w.settingsVersion ?? '—')}</td><td>${esc(w.attemptId ?? w.activeAttemptId ?? (w.busy ? 'Đang bận' : 'Sẵn sàng'))}</td>${compact ? '' : `<td>${esc(time(w.lastSeen ?? w.lastSeenAt ?? w.lastHeartbeatAt))}<details><summary>Kết nối hiệu lực</summary><pre>${esc(JSON.stringify(w.connection ?? {}, null, 2))}</pre></details></td>`}</tr>`,
  );
}
function render() {
  $('nav-flow-count').textContent = state.workflows.length;
  const active = state.runs.filter((r) =>
    ['running', 'queued', 'waiting', 'paused'].includes(r.state ?? r.status),
  ).length;
  const online = state.workers.filter((w) => w.status !== 'offline' && w.online !== false).length;
  $('stats').innerHTML = [
    ['Workflows đã publish', state.workflows.length, 'Phiên bản sẵn sàng', '⤳'],
    ['Đang hoạt động', active, 'Đang chạy, chờ hoặc tạm dừng', '◷'],
    ['Workers kết nối', online, `${state.workers.length} Worker đã đăng ký`, '▣'],
    [
      'Hoàn thành',
      state.runs.filter((r) => (r.state ?? r.status) === 'succeeded').length,
      'Kết quả có thể tải nguyên bản',
      '✓',
    ],
  ]
    .map(
      ([label, count, sub, icon]) =>
        `<div class="stat"><label>${esc(label)}</label><span class="stat-icon">${icon}</span><strong>${count}</strong><small>${esc(sub)}</small></div>`,
    )
    .join('');
  $('recent-runs').innerHTML = state.runs.length
    ? table(['Workflow', 'Trạng thái', 'Tạo lúc', ''], runRows(state.runs.slice(0, 6)))
    : empty('Chưa có lượt chạy', 'Publish một workflow rồi bắt đầu với input của bạn.');
  $('run-list').innerHTML = state.runs.length
    ? table(['Workflow / Run ID', 'Trạng thái', 'Tạo lúc', ''], runRows(state.runs))
    : empty('Lịch sử đang trống', 'Các lượt chạy sẽ xuất hiện tại đây.');
  $('overview-workers').innerHTML = state.workers.length
    ? table(
        ['Worker', 'Trạng thái', 'Cấu hình v.', 'Lần thực thi'],
        workerRows(state.workers, true),
      )
    : empty('Chờ Worker đầu tiên', 'Khởi động Worker và ghép đôi với Manager.');
  $('worker-list').innerHTML = state.workers.length
    ? table(
        [
          'Worker / ID',
          'Trạng thái',
          'Cấu hình v.',
          'Lần thực thi',
          'Heartbeat / cấu hình hiệu lực',
        ],
        workerRows(state.workers),
      )
    : empty('Chưa có Worker', 'Worker sẽ xuất hiện sau khi ghép đôi.');
  const tabs = state.drafts.flows.filter((n) => n.type === 'tab');
  $('draft-list').innerHTML = tabs.length
    ? table(
        ['Bản nháp', 'Node', 'Thao tác'],
        tabs.map(
          (t) =>
            `<tr><td><strong>${esc(t.label || t.id)}</strong><span class="id">${esc(t.id)}</span></td><td>${state.drafts.flows.filter((n) => n.z === t.id && n.type !== 'comment').length}</td><td><div class="actions"><a href="/flows/#flow/${encodeURIComponent(t.id)}" target="_blank" class="button">Chỉnh sửa ↗</a><button data-clone-draft="${esc(t.id)}">Nhân bản</button><button data-publish="${esc(t.id)}" class="primary">Publish</button></div></td></tr>`,
        ),
      )
    : empty('Chưa có bản nháp', 'Tạo workflow mẫu hoặc mở Node-RED để thiết kế.');
  $('workflow-list').innerHTML = state.workflows.length
    ? table(
        ['Workflow', 'Phiên bản', 'Trạng thái', 'Thao tác'],
        state.workflows.map((w) => {
          const d = definition(w);
          return `<tr><td><strong>${esc(d.name ?? w.name)}</strong><span class="id">${esc(d.id ?? w.id)}</span></td><td>v${esc(w.version ?? d.version ?? 1)}</td><td>${badge(d.enabled ? 'enabled' : 'disabled')}</td><td><div class="actions"><button data-start="${esc(d.id)}" class="primary" ${!d.enabled ? 'disabled' : ''}>Chạy →</button><button data-toggle="${esc(d.id)}">${d.enabled ? 'Tắt' : 'Bật'}</button><button data-clone="${esc(d.id)}">Nhân bản</button><button data-export="${esc(d.id)}">JSON ↓</button></div></td></tr>`;
        }),
      )
    : empty(
        'Chưa có phiên bản Publish',
        'Deploy bản nháp trong Node-RED rồi bấm Publish ở phía trên.',
      );
  bindActions();
}
const settingGroups = {
  connection: [
    'Kết nối Worker',
    {
      longPollWaitSec: 'Long poll · thời gian chờ',
      longPollHttpTimeoutSec: 'HTTP long poll timeout',
      apiRequestTimeoutSec: 'API request timeout',
      heartbeatIntervalSec: 'Chu kỳ heartbeat',
      offlineAfterSec: 'Đánh dấu offline sau',
      preSendLeaseSec: 'Lease trước khi gửi',
      artifactTransferIdleSec: 'Artifact idle timeout',
    },
  ],
  execution: [
    'Thời gian thực thi',
    {
      noProgressTimeoutSec: 'Không có tiến triển',
      stepTotalTimeoutSec: 'Giới hạn một bước',
      workflowTotalTimeoutSec: 'Giới hạn toàn workflow',
      timeoutAction: 'Hành động khi timeout',
    },
  ],
  limits: [
    'Giới hạn vận hành',
    {
      globalConcurrentRuns: 'Số lượt chạy đồng thời',
      perWorkflowConcurrentRuns: 'Đồng thời / workflow',
      maxQueuedRuns: 'Số lượt chờ tối đa',
      maxStepExecutions: 'Số bước / lượt chạy',
      maxChainRuns: 'Số workflow nối chuỗi',
    },
  ],
};
function renderSettings() {
  if (!state.settings) return;
  $('settings-form').innerHTML = Object.entries(settingGroups)
    .map(
      ([group, [title, fields]]) =>
        `<article class="panel settings-section"><div class="panel-title"><h2>${title}</h2><span class="muted">${group} · v${state.settings.version}</span></div><div class="settings-grid">${Object.entries(
          fields,
        )
          .map(
            ([key, label]) =>
              `<div class="field"><label for="set-${key}">${label}</label>${key === 'timeoutAction' ? `<select id="set-${key}" data-group="${group}" data-key="${key}">${['warn', 'pause', 'stop'].map((v) => `<option ${state.settings[group][key] === v ? 'selected' : ''}>${v}</option>`).join('')}</select>` : `<input id="set-${key}" data-group="${group}" data-key="${key}" type="number" min="0" placeholder="null · không giới hạn" value="${state.settings[group][key] ?? ''}">`}<small>${key}</small></div>`,
          )
          .join('')}</div></article>`,
    )
    .join('');
  $('worker-overrides').value = JSON.stringify(state.settings.workerOverrides ?? {}, null, 2);
}
async function refresh(forceSettings = false) {
  try {
    const [workflows, runs, workers, drafts, settings] = await Promise.all([
      api('/api/v1/workflows'),
      api('/api/v1/runs'),
      api('/api/v1/workers'),
      api('/api/v1/editor/drafts'),
      api('/api/v1/settings'),
    ]);
    state.workflows = array(workflows, 'workflows');
    state.runs = array(runs, 'runs');
    state.workers = array(workers, 'workers');
    state.drafts = drafts;
    const first = !state.settings;
    state.settings = settings.settings ?? settings;
    $('login').hidden = true;
    $('shell').hidden = false;
    render();
    if (first || forceSettings) renderSettings();
    $('last-sync').textContent = 'Đồng bộ ' + new Date().toLocaleTimeString('vi-VN');
    if (state.runId && state.view === 'runs') await loadRun(state.runId);
  } catch (e) {
    if (!$('shell').hidden) notice(e.message, true);
    else $('login-error').textContent = e.message;
  }
}
async function jsonDialog(title, value, hint, action) {
  $('dialog-title').textContent = title;
  $('dialog-hint').textContent = hint;
  $('dialog-json').value = JSON.stringify(value, null, 2);
  $('json-dialog').showModal();
  return new Promise((resolve) => {
    $('json-dialog').onclose = async () => {
      if ($('json-dialog').returnValue === 'ok') {
        try {
          await action(JSON.parse($('dialog-json').value));
          resolve(true);
        } catch (e) {
          notice(e.message, true);
          resolve(false);
        }
      } else resolve(false);
    };
  });
}
function download(filename, value) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function action(fn) {
  try {
    await fn();
    await refresh();
  } catch (e) {
    notice(e.message, true);
  }
}
function bindActions() {
  document.querySelectorAll('[data-run]').forEach(
    (b) =>
      (b.onclick = () => {
        show('runs');
        action(() => loadRun(b.dataset.run));
      }),
  );
  document.querySelectorAll('[data-publish]').forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await post('/api/v1/editor/publish', {
            tabId: b.dataset.publish,
            revision: state.drafts.rev,
          });
          notice('Đã Publish phiên bản workflow.');
        })),
  );
  document.querySelectorAll('[data-start]').forEach(
    (b) =>
      (b.onclick = () =>
        jsonDialog(
          'Bắt đầu lượt chạy',
          { topic: '' },
          'Input được truyền vào template của workflow.',
          async (input) => {
            const run = await post(
              `/api/v1/workflows/${encodeURIComponent(b.dataset.start)}/runs`,
              { input },
            );
            notice('Đã tạo lượt chạy.');
            show('runs');
            state.runId = run.id ?? run.run?.id;
            await refresh();
          },
        )),
  );
  document.querySelectorAll('[data-toggle]').forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          const w = definition(state.workflows.find((w) => definition(w).id === b.dataset.toggle));
          await post('/api/v1/workflows', { ...w, enabled: !w.enabled });
          notice('Đã cập nhật trạng thái workflow.');
        })),
  );
  document.querySelectorAll('[data-clone]').forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          const w = definition(state.workflows.find((w) => definition(w).id === b.dataset.clone));
          await post('/api/v1/workflows', {
            ...w,
            id: crypto.randomUUID(),
            name: w.name + ' · Bản sao',
          });
          notice('Đã nhân bản phiên bản workflow.');
        })),
  );
  document
    .querySelectorAll('[data-export]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          download(
            b.dataset.export + '.json',
            definition(state.workflows.find((w) => definition(w).id === b.dataset.export)),
          )),
    );
  document.querySelectorAll('[data-clone-draft]').forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          const tab = state.drafts.flows.find((n) => n.id === b.dataset.cloneDraft),
            nodes = state.drafts.flows.filter((n) => n.id === tab.id || n.z === tab.id);
          const ids = new Map(nodes.map((n) => [n.id, crypto.randomUUID()]));
          const clones = nodes.map((n) => ({
            ...n,
            id: ids.get(n.id),
            ...(n.z ? { z: ids.get(n.z) } : {}),
            ...(n.type === 'tab' ? { label: (n.label || 'Workflow') + ' · Bản sao' } : {}),
            ...(n.target ? { target: ids.get(n.target) ?? n.target } : {}),
            ...(n.outputNodeId ? { outputNodeId: ids.get(n.outputNodeId) ?? n.outputNodeId } : {}),
            ...(n.wires ? { wires: n.wires.map((out) => out.map((id) => ids.get(id) ?? id)) } : {}),
          }));
          await post('/api/v1/editor/drafts', {
            rev: state.drafts.rev,
            flows: [...state.drafts.flows, ...clones],
          });
          notice('Đã nhân bản bản nháp.');
        })),
  );
}
async function loadRun(id) {
  const result = await api('/api/v1/runs/' + encodeURIComponent(id));
  const run = result.run ?? result;
  state.runId = id;
  $('run-detail').hidden = false;
  const artifacts = new Set();
  const collect = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'artifactId' || k === 'outputArtifactId') && typeof v === 'string')
        artifacts.add(v);
      else if (typeof v === 'object') collect(v);
    }
  };
  collect(result);
  const active = (result.attempts ?? run.attempts ?? []).filter((a) =>
    ['assigned', 'sending', 'running', 'uncertain'].includes(a.state),
  );
  $('run-detail').innerHTML =
    `<div class="run-title"><div><h2>Trace lượt chạy</h2><span class="id">${esc(id)}</span></div><div class="actions">${['pause', 'resume', 'stop'].map((a) => `<button data-control="${a}">${{ pause: 'Tạm dừng', resume: 'Tiếp tục', stop: 'Dừng' }[a]}</button>`).join('')}</div></div><p>${badge(run.state ?? run.status)}</p>${[...artifacts].map((a) => `<div><span class="id">Artifact · ${esc(a)}</span><a class="artifact-link" download href="/api/v1/artifacts/${encodeURIComponent(a)}">↓ Markdown nguyên bản</a><a class="artifact-link" download href="/api/v1/artifacts/${encodeURIComponent(a)}?format=txt">↓ TXT</a><a class="artifact-link" download href="/api/v1/artifacts/${encodeURIComponent(a)}?format=json">↓ JSON</a></div>`).join('')}${
      active.length
        ? `<div class="attempt-reconcile"><h2>Đối chiếu thủ công</h2><p class="muted">Mở hội thoại trên Worker để kiểm tra trước khi xử lý attempt. Hệ thống không tự gửi lại.</p>${table(
            ['Attempt / Worker', 'Trạng thái', 'Thao tác'],
            active.map(
              (a) =>
                `<tr><td><span class="id">${esc(a.id)}</span>${esc(a.workerId)}</td><td>${badge(a.state)}</td><td><button data-resolve="${esc(a.id)}">Kiểm tra và xử lý…</button></td></tr>`,
            ),
          )}</div>`
        : ''
    }<details open><summary>Trạng thái, các bước và sự kiện</summary><pre>${esc(JSON.stringify(result, null, 2))}</pre></details>`;
  document.querySelectorAll('[data-control]').forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await post('/api/v1/runs/' + encodeURIComponent(id) + '/control', {
            action: b.dataset.control,
          });
          notice('Đã gửi lệnh ' + b.textContent.toLowerCase());
        })),
  );
  document
    .querySelectorAll('[data-resolve]')
    .forEach((b) => (b.onclick = () => openResolution(b.dataset.resolve)));
}
function openResolution(attemptId) {
  $('resolve-form').reset();
  $('resolve-error').textContent = '';
  $('resolve-attempt').textContent = 'Attempt · ' + attemptId;
  $('resolve-dialog').dataset.attemptId = attemptId;
  $('resolve-dialog').showModal();
}
$('resolve-cancel').onclick = $('resolve-back').onclick = () => $('resolve-dialog').close();
$('resolve-form').onsubmit = async (e) => {
  e.preventDefault();
  const form = $('resolve-form'),
    choice = new FormData(form).get('resolution'),
    note = $('resolve-note').value.trim();
  if (!['notSent', 'abandon'].includes(choice) || !note) {
    $('resolve-error').textContent = 'Chọn kết quả kiểm tra và ghi rõ nội dung đã đối chiếu.';
    return;
  }
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await post(
      '/api/v1/attempts/' + encodeURIComponent($('resolve-dialog').dataset.attemptId) + '/resolve',
      { action: choice, note },
    );
    $('resolve-dialog').close();
    notice('Đã lưu quyết định đối chiếu.');
    await refresh();
  } catch (error) {
    $('resolve-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

async function createExample() {
  await action(async () => {
    const raw = await fetch('/example-review.json').then((r) => r.json());
    const suffix = crypto.randomUUID().slice(0, 8),
      ids = new Map(raw.map((n) => [n.id, n.id + '-' + suffix]));
    const nodes = raw.map((n) => ({
      ...n,
      id: ids.get(n.id),
      ...(n.z ? { z: ids.get(n.z) } : {}),
      ...(n.target ? { target: ids.get(n.target) } : {}),
      ...(n.outputNodeId ? { outputNodeId: ids.get(n.outputNodeId) } : {}),
      ...(n.wires ? { wires: n.wires.map((o) => o.map((id) => ids.get(id))) } : {}),
    }));
    await post('/api/v1/editor/drafts', {
      rev: state.drafts.rev,
      flows: [...state.drafts.flows, ...nodes],
    });
    show('workflows');
    notice('Đã tạo bản nháp mẫu. Mở Node-RED để chỉnh sửa hoặc Publish.');
  });
}
$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await post('/api/v1/login', { token: $('token').value });
    $('token').value = '';
    await refresh(true);
  } catch (e) {
    $('login-error').textContent = e.message;
  }
};
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => show(b.dataset.view)));
document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => show(b.dataset.go)));
$('refresh').onclick = () => refresh();
$('new-example').onclick = createExample;
$('save-settings').onclick = () =>
  action(async () => {
    const settings = {
      connection: {},
      execution: {},
      limits: {},
      workerOverrides: JSON.parse($('worker-overrides').value),
    };
    document
      .querySelectorAll('[data-group]')
      .forEach(
        (i) =>
          (settings[i.dataset.group][i.dataset.key] =
            i.tagName === 'SELECT' ? i.value : i.value === '' ? null : Number(i.value)),
      );
    state.settings = await api('/api/v1/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
    renderSettings();
    notice('Đã lưu cấu hình. Worker nhận phiên bản mới khi kết nối.');
  });
$('export-settings').onclick = () => download('agent-flow-settings.json', state.settings);
$('import-settings').onclick = () =>
  jsonDialog(
    'Nhập cấu hình',
    state.settings,
    'Cấu hình được kiểm tra tại Manager trước khi lưu.',
    async (value) => {
      await api('/api/v1/settings', { method: 'PUT', body: JSON.stringify(value) });
      await refresh(true);
      notice('Đã nhập cấu hình.');
    },
  );
$('import-workflow').onclick = () =>
  jsonDialog(
    'Nhập workflow hoặc bản nháp',
    {},
    'WorkflowDefinition → Publish; mảng Node-RED → thêm bản nháp.',
    async (value) => {
      if (Array.isArray(value))
        await post('/api/v1/editor/drafts', {
          rev: state.drafts.rev,
          flows: [...state.drafts.flows, ...value],
        });
      else await post('/api/v1/workflows', value);
      await refresh();
      notice('Đã nhập JSON.');
    },
  );
refresh();
setInterval(() => {
  if (!$('shell').hidden && state.view !== 'settings' && !$('json-dialog').open) refresh();
}, 10000);
