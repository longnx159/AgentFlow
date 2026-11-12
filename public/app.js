import { DEFAULT_LANG, STORAGE_KEY, normalizeLang, translate } from '/i18n.js';

const $ = (id) => document.getElementById(id);
let currentLang = (() => {
  try {
    return normalizeLang(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_LANG);
  } catch {
    return DEFAULT_LANG;
  }
})();

let state = {
  workflows: [],
  workers: [],
  runs: [],
  drafts: { flows: [] },
  settings: null,
  view: 'overview',
  runId: null,
  lastRunDetail: null,
  lastSyncAt: null,
};

const t = (key, params) => translate(currentLang, key, params);
const locale = () => (currentLang === 'en' ? 'en-US' : 'vi-VN');

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
  v ? new Date(typeof v === 'number' ? v : Date.parse(v)).toLocaleString(locale()) : '—';

function applyStaticTranslations(root = document) {
  if (root === document) {
    document.documentElement.lang = currentLang;
    document.title = t('app.title');
    document.querySelectorAll('.lang-switch button[data-lang]').forEach((btn) => {
      const active = btn.dataset.lang === currentLang;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  if (root === document) {
    if ($('page-label')) $('page-label').textContent = t('nav.' + state.view);
    if (state.lastSyncAt && $('last-sync')) {
      $('last-sync').textContent = t('aside.syncedAt', {
        time: new Date(state.lastSyncAt).toLocaleTimeString(locale()),
      });
    }
  }
}

function setLanguage(lang) {
  currentLang = normalizeLang(lang);
  try {
    localStorage.setItem(STORAGE_KEY, currentLang);
  } catch {}
  applyStaticTranslations();
  if (!$('shell').hidden) {
    render();
    if (state.lastRunDetail && state.view === 'runs') renderRunDetail(state.lastRunDetail);
  }
}

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
  $('page-label').textContent = t('nav.' + view);
  if (view === 'settings' && !state.settings) refresh();
}

function table(headers, rows) {
  return `<table class="table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function runRows(runs) {
  return runs.map(
    (r) =>
      `<tr><td><strong>${esc(r.workflowName ?? r.workflowId)}</strong><span class="id">${esc(r.id)}</span></td><td>${badge(r.state ?? r.status)}</td><td>${esc(time(r.createdAt ?? r.startedAt))}</td><td><button data-run="${esc(r.id)}">${esc(t('action.viewTrace'))}</button></td></tr>`,
  );
}

function workerRows(workers, compact = false) {
  return workers.map(
    (w) =>
      `<tr><td><strong>${esc(w.name ?? w.id ?? w.workerId)}</strong><span class="id">${esc(w.id ?? w.workerId)}</span></td><td>${badge(w.status ?? (w.busy || w.attemptId ? 'busy' : w.online === false ? 'offline' : 'online'))}</td><td>${esc(w.settingsVersion ?? '—')}</td><td>${esc(w.attemptId ?? w.activeAttemptId ?? (w.busy ? t('worker.busy') : t('worker.idle')))}</td>${compact ? '' : `<td>${esc(time(w.lastSeen ?? w.lastSeenAt ?? w.lastHeartbeatAt))}<details><summary>${esc(t('worker.effectiveConn'))}</summary><pre>${esc(JSON.stringify(w.connection ?? {}, null, 2))}</pre></details></td>`}</tr>`,
  );
}

function render() {
  $('nav-flow-count').textContent = state.workflows.length;
  const active = state.runs.filter((r) =>
    ['running', 'queued', 'waiting', 'paused'].includes(r.state ?? r.status),
  ).length;
  const online = state.workers.filter((w) => w.status !== 'offline' && w.online !== false).length;
  $('stats').innerHTML = [
    [t('stats.publishedLabel'), state.workflows.length, t('stats.publishedSub'), '⤳'],
    [t('stats.activeLabel'), active, t('stats.activeSub'), '◷'],
    [t('stats.workersLabel'), online, t('stats.workersSub', { count: state.workers.length }), '▣'],
    [
      t('stats.succeededLabel'),
      state.runs.filter((r) => (r.state ?? r.status) === 'succeeded').length,
      t('stats.succeededSub'),
      '✓',
    ],
  ]
    .map(
      ([label, count, sub, icon]) =>
        `<div class="stat"><label>${esc(label)}</label><span class="stat-icon">${icon}</span><strong>${count}</strong><small>${esc(sub)}</small></div>`,
    )
    .join('');
  $('recent-runs').innerHTML = state.runs.length
    ? table(
        [t('table.workflow'), t('table.status'), t('table.createdAt'), ''],
        runRows(state.runs.slice(0, 6)),
      )
    : empty(t('empty.recentRunsTitle'), t('empty.recentRunsText'));
  $('run-list').innerHTML = state.runs.length
    ? table(
        [t('table.workflowRunId'), t('table.status'), t('table.createdAt'), ''],
        runRows(state.runs),
      )
    : empty(t('empty.runsTitle'), t('empty.runsText'));
  $('overview-workers').innerHTML = state.workers.length
    ? table(
        [t('table.worker'), t('table.status'), t('table.settingsVersion'), t('table.attempt')],
        workerRows(state.workers, true),
      )
    : empty(t('empty.overviewWorkersTitle'), t('empty.overviewWorkersText'));
  $('worker-list').innerHTML = state.workers.length
    ? table(
        [
          t('table.workerId'),
          t('table.status'),
          t('table.settingsVersion'),
          t('table.attempt'),
          t('table.heartbeatConfig'),
        ],
        workerRows(state.workers),
      )
    : empty(t('empty.workersTitle'), t('empty.workersText'));
  const tabs = state.drafts.flows.filter((n) => n.type === 'tab');
  $('draft-list').innerHTML = tabs.length
    ? table(
        [t('table.draft'), t('table.nodes'), t('table.actions')],
        tabs.map(
          (tNode) =>
            `<tr><td><strong>${esc(tNode.label || tNode.id)}</strong><span class="id">${esc(tNode.id)}</span></td><td>${state.drafts.flows.filter((n) => n.z === tNode.id && n.type !== 'comment').length}</td><td><div class="actions"><a href="/flows/#flow/${encodeURIComponent(tNode.id)}" target="_blank" class="button">${esc(t('action.edit'))}</a><button data-clone-draft="${esc(tNode.id)}">${esc(t('action.clone'))}</button><button data-publish="${esc(tNode.id)}" class="primary">${esc(t('action.publish'))}</button></div></td></tr>`,
        ),
      )
    : empty(t('empty.draftsTitle'), t('empty.draftsText'));
  $('workflow-list').innerHTML = state.workflows.length
    ? table(
        [t('table.workflow'), t('table.version'), t('table.status'), t('table.actions')],
        state.workflows.map((w) => {
          const d = definition(w);
          return `<tr><td><strong>${esc(d.name ?? w.name)}</strong><span class="id">${esc(d.id ?? w.id)}</span></td><td>v${esc(w.version ?? d.version ?? 1)}</td><td>${badge(d.enabled ? 'enabled' : 'disabled')}</td><td><div class="actions"><button data-start="${esc(d.id)}" class="primary" ${!d.enabled ? 'disabled' : ''}>${esc(t('action.run'))}</button><button data-toggle="${esc(d.id)}">${esc(d.enabled ? t('action.disable') : t('action.enable'))}</button><button data-clone="${esc(d.id)}">${esc(t('action.clone'))}</button><button data-export="${esc(d.id)}">${esc(t('action.exportJson'))}</button></div></td></tr>`;
        }),
      )
    : empty(t('empty.workflowsTitle'), t('empty.workflowsText'));
  bindActions();
}

const settingGroups = {
  connection: [
    'longPollWaitSec',
    'longPollHttpTimeoutSec',
    'apiRequestTimeoutSec',
    'heartbeatIntervalSec',
    'offlineAfterSec',
    'preSendLeaseSec',
    'artifactTransferIdleSec',
  ],
  execution: [
    'noProgressTimeoutSec',
    'stepTotalTimeoutSec',
    'workflowTotalTimeoutSec',
    'timeoutAction',
  ],
  limits: [
    'globalConcurrentRuns',
    'perWorkflowConcurrentRuns',
    'maxQueuedRuns',
    'maxStepExecutions',
    'maxChainRuns',
  ],
};

function renderSettings() {
  if (!state.settings) return;
  $('settings-form').innerHTML = Object.entries(settingGroups)
    .map(
      ([group, keys]) =>
        `<article class="panel settings-section"><div class="panel-title"><h2 data-i18n="settings.groups.${group}">${esc(t('settings.groups.' + group))}</h2><span class="muted">${group} · v${state.settings.version}</span></div><div class="settings-grid">${keys
          .map(
            (key) =>
              `<div class="field"><label for="set-${key}" data-i18n="settings.fields.${key}">${esc(t('settings.fields.' + key))}</label>${key === 'timeoutAction' ? `<select id="set-${key}" data-group="${group}" data-key="${key}">${['warn', 'pause', 'stop'].map((v) => `<option ${state.settings[group][key] === v ? 'selected' : ''}>${v}</option>`).join('')}</select>` : `<input id="set-${key}" data-group="${group}" data-key="${key}" type="number" min="0" data-i18n-placeholder="settings.nullPlaceholder" placeholder="${esc(t('settings.nullPlaceholder'))}" value="${state.settings[group][key] ?? ''}">`}<small>${key}</small></div>`,
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
    state.lastSyncAt = Date.now();
    $('login').hidden = true;
    $('shell').hidden = false;
    render();
    if (first || forceSettings) renderSettings();
    $('last-sync').textContent = t('aside.syncedAt', {
      time: new Date(state.lastSyncAt).toLocaleTimeString(locale()),
    });
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
          notice(t('notice.published'));
        })),
  );
  document.querySelectorAll('[data-start]').forEach(
    (b) =>
      (b.onclick = () =>
        jsonDialog(t('dialog.startTitle'), { topic: '' }, t('dialog.startHint'), async (input) => {
          const run = await post(`/api/v1/workflows/${encodeURIComponent(b.dataset.start)}/runs`, {
            input,
          });
          notice(t('notice.runCreated'));
          show('runs');
          state.runId = run.id ?? run.run?.id;
          await refresh();
        })),
  );
  document.querySelectorAll('[data-toggle]').forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          const w = definition(state.workflows.find((w) => definition(w).id === b.dataset.toggle));
          await post('/api/v1/workflows', { ...w, enabled: !w.enabled });
          notice(t('notice.workflowToggled'));
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
            name: w.name + t('clone.suffix'),
          });
          notice(t('notice.workflowCloned'));
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
            ...(n.type === 'tab' ? { label: (n.label || 'Workflow') + t('clone.suffix') } : {}),
            ...(n.target ? { target: ids.get(n.target) ?? n.target } : {}),
            ...(n.outputNodeId ? { outputNodeId: ids.get(n.outputNodeId) ?? n.outputNodeId } : {}),
            ...(n.wires ? { wires: n.wires.map((out) => out.map((id) => ids.get(id) ?? id)) } : {}),
          }));
          await post('/api/v1/editor/drafts', {
            rev: state.drafts.rev,
            flows: [...state.drafts.flows, ...clones],
          });
          notice(t('notice.draftCloned'));
        })),
  );
}

function renderRunDetail(result) {
  const run = result.run ?? result;
  const id = run.id ?? state.runId;
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
  const controlLabels = {
    pause: t('action.pause'),
    resume: t('action.resume'),
    stop: t('action.stop'),
  };
  $('run-detail').innerHTML =
    `<div class="run-title"><div><h2>${esc(t('run.traceTitle'))}</h2><span class="id">${esc(id)}</span></div><div class="actions">${['pause', 'resume', 'stop'].map((a) => `<button data-control="${a}">${esc(controlLabels[a])}</button>`).join('')}</div></div><p>${badge(run.state ?? run.status)}</p>${[...artifacts].map((a) => `<div><span class="id">Artifact · ${esc(a)}</span><a class="artifact-link" download href="/api/v1/artifacts/${encodeURIComponent(a)}">${esc(t('run.rawMarkdown'))}</a><a class="artifact-link" download href="/api/v1/artifacts/${encodeURIComponent(a)}?format=txt">↓ TXT</a><a class="artifact-link" download href="/api/v1/artifacts/${encodeURIComponent(a)}?format=json">↓ JSON</a></div>`).join('')}${
      active.length
        ? `<div class="attempt-reconcile"><h2>${esc(t('run.reconcileTitle'))}</h2><p class="muted">${esc(t('run.reconcileHint'))}</p>${table(
            [t('table.attemptWorker'), t('table.status'), t('table.action')],
            active.map(
              (a) =>
                `<tr><td><span class="id">${esc(a.id)}</span>${esc(a.workerId)}</td><td>${badge(a.state)}</td><td><button data-resolve="${esc(a.id)}">${esc(t('action.inspectResolve'))}</button></td></tr>`,
            ),
          )}</div>`
        : ''
    }<details open><summary>${esc(t('run.detailsSummary'))}</summary><pre>${esc(JSON.stringify(result, null, 2))}</pre></details>`;
  document.querySelectorAll('[data-control]').forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await post('/api/v1/runs/' + encodeURIComponent(id) + '/control', {
            action: b.dataset.control,
          });
          notice(t('run.commandSent', { action: b.textContent.toLowerCase() }));
        })),
  );
  document
    .querySelectorAll('[data-resolve]')
    .forEach((b) => (b.onclick = () => openResolution(b.dataset.resolve)));
}

async function loadRun(id) {
  const result = await api('/api/v1/runs/' + encodeURIComponent(id));
  state.runId = id;
  state.lastRunDetail = result;
  renderRunDetail(result);
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
    $('resolve-error').textContent = t('resolve.validationError');
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
    notice(t('resolve.saved'));
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
    notice(t('notice.exampleCreated'));
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

document.querySelectorAll('.lang-switch button[data-lang]').forEach((b) => {
  b.onclick = () => setLanguage(b.dataset.lang);
});
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
    notice(t('notice.settingsSaved'));
  });
$('export-settings').onclick = () => download('agent-flow-settings.json', state.settings);
$('import-settings').onclick = () =>
  jsonDialog(
    t('dialog.importSettingsTitle'),
    state.settings,
    t('dialog.importSettingsHint'),
    async (value) => {
      await api('/api/v1/settings', { method: 'PUT', body: JSON.stringify(value) });
      await refresh(true);
      notice(t('notice.settingsImported'));
    },
  );
$('import-workflow').onclick = () =>
  jsonDialog(t('dialog.importWorkflowTitle'), {}, t('dialog.importWorkflowHint'), async (value) => {
    if (Array.isArray(value))
      await post('/api/v1/editor/drafts', {
        rev: state.drafts.rev,
        flows: [...state.drafts.flows, ...value],
      });
    else await post('/api/v1/workflows', value);
    await refresh();
    notice(t('notice.jsonImported'));
  });

applyStaticTranslations();
refresh();
setInterval(() => {
  if (!$('shell').hidden && state.view !== 'settings' && !$('json-dialog').open) refresh();
}, 10000);
