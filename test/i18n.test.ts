import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const i18nModule = () => import(new URL('../public/i18n.js', import.meta.url).href);

test('Manager i18n dictionary provides complete matching vi and en keys', async () => {
  const { SUPPORTED_LANGS, DEFAULT_LANG, MESSAGES, normalizeLang, translate } = await i18nModule();
  assert.deepEqual(SUPPORTED_LANGS, ['vi', 'en']);
  assert.equal(DEFAULT_LANG, 'vi');
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('vi'), 'vi');
  assert.equal(normalizeLang('fr'), 'vi');

  const viKeys = Object.keys(MESSAGES.vi).sort();
  const enKeys = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(enKeys, viKeys);

  for (const key of viKeys) {
    assert.ok(MESSAGES.vi[key].trim().length > 0, `Empty vi translation for ${key}`);
    assert.ok(MESSAGES.en[key].trim().length > 0, `Empty en translation for ${key}`);
  }

  assert.equal(translate('vi', 'stats.workersSub', { count: 4 }), '4 Worker đã đăng ký');
  assert.equal(translate('en', 'stats.workersSub', { count: 4 }), '4 registered Workers');
});

test('Manager index.html and app.js reference only defined i18n keys', async () => {
  const { MESSAGES } = await i18nModule();
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  for (const match of html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) {
    const key = match[1];
    assert.ok(key in MESSAGES.vi, `Missing vi key from index.html: ${key}`);
    assert.ok(key in MESSAGES.en, `Missing en key from index.html: ${key}`);
  }

  for (const match of js.matchAll(/\bt\('([^']+)'(?=[,)])/g)) {
    const key = match[1];
    assert.ok(key in MESSAGES.vi, `Missing vi key from app.js: ${key}`);
    assert.ok(key in MESSAGES.en, `Missing en key from app.js: ${key}`);
  }
  for (const view of ['overview', 'workflows', 'runs', 'workers', 'settings']) {
    const key = `nav.${view}`;
    assert.ok(key in MESSAGES.vi, `Missing vi key: ${key}`);
    assert.ok(key in MESSAGES.en, `Missing en key: ${key}`);
  }
});

test('Worker UI embeds matching en and vi translations for all data-i18n attributes', () => {
  const html = readFileSync(new URL('../src/worker/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-lang="vi"/);
  assert.match(html, /data-lang="en"/);
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
    const key = match[1];
    assert.ok(
      html.includes(`'${key}':`) || html.includes(`${key}:`),
      `Worker UI missing translation key: ${key}`,
    );
  }
});
