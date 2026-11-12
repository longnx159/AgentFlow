import type { BrowserSession, SendReceipt } from './browser.js';
import { chromium, type Browser, type Page } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
// Adapted from browser-ai-bridge MIT locators/dom.js at
// de112345daecaf6f2c6d480099de783da7873737. See vendor/browser-ai-bridge/LICENSE.
const INPUT =
  '#prompt-textarea, [data-testid="composer-input"], form[data-chatgpt-composer] [contenteditable="true"], div.ProseMirror[contenteditable="true"], div[contenteditable="true"]';
const SEND =
  '[data-testid="send-button"], button[aria-label="Send message"], button[aria-label="Send"]';
export interface ChromeOptions {
  dataDir: string;
  profileDir?: string;
  chromePath?: string;
  headless?: boolean;
  cdpPort?: number;
  offscreen?: boolean;
}
export class ChromeBrowserSession implements BrowserSession {
  private browser?: Browser;
  private connecting?: Promise<Browser>;
  private pages = new Map<string, Page>();
  private prompts = new Map<string, string>();
  private loginPage?: Page;
  constructor(
    private options: ChromeOptions,
    private connect?: () => Promise<any>,
  ) {}
  private async connected(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browser && !this.browser.isConnected()) this.browser = undefined;
    if (!this.connecting)
      this.connecting = this.open().finally(() => {
        this.connecting = undefined;
      });
    return (this.browser = await this.connecting);
  }
  async ready(): Promise<boolean> {
    const browser = await this.connected();
    if (!this.loginPage || this.loginPage.isClosed()) {
      this.loginPage =
        browser
          .contexts()[0]
          .pages()
          .find((p) => p.url().startsWith('https://chatgpt.com/')) ??
        (await browser.contexts()[0].newPage());
      if (!this.loginPage.url().startsWith('https://chatgpt.com/'))
        await this.loginPage.goto('https://chatgpt.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
    }
    return this.loginPage.evaluate(async () => {
      try {
        const s = await fetch('/api/auth/session', {
          credentials: 'include',
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.json());
        return !!s?.accessToken;
      } catch {
        return false;
      }
    });
  }
  private async open(): Promise<Browser> {
    if (this.connect) return this.connect();
    const profile = resolve(
      this.options.profileDir ?? join(this.options.dataDir, 'chrome-profile'),
    );
    mkdirSync(profile, { recursive: true });
    const port = this.options.cdpPort ?? 9223;
    const endpoint = `http://127.0.0.1:${port}`;
    let alive = false;
    try {
      alive = (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {}
    if (!alive) {
      const executable =
        this.options.chromePath ??
        [
          join(
            process.env.PROGRAMFILES ?? 'C:/Program Files',
            'Google/Chrome/Application/chrome.exe',
          ),
          join(
            process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)',
            'Google/Chrome/Application/chrome.exe',
          ),
          join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
        ].find(existsSync);
      if (!executable)
        throw Error('Chrome not found. Set CHROME_PATH; human login requires headed Chrome.');
      const args = [
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--enable-automation',
        '--no-first-run',
        '--no-default-browser-check',
        '--restore-last-session',
      ];
      if (this.options.headless) args.push('--headless=new');
      if (this.options.offscreen) args.push('--window-position=-2400,0');
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          if ((await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) {
            alive = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!alive) throw Error('Chrome CDP startup timed out; check profile lock and CDP_PORT');
    }
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    // Refuse an unrelated CDP browser: the debugging port must belong to the
    // explicitly isolated profile. The standard automation flag stays visible.
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
      const actual = args
        .find((a: string) => a.startsWith('--user-data-dir='))
        ?.slice('--user-data-dir='.length);
      if (!actual || resolve(actual).toLowerCase() !== profile.toLowerCase())
        throw Error('CDP port belongs to another Chrome profile; choose a separate CDP_PORT');
    } catch (error) {
      await browser.close();
      throw error;
    } finally {
      await cdp.detach().catch(() => {});
    }
    return browser;
  }
  async prepare(prompt: string, marker: string): Promise<SendReceipt> {
    const browser = await this.connected();
    const context = browser.contexts()[0];
    if (!context) throw Error('No Chrome context');
    const page = await context.newPage();
    this.pages.set(marker, page);
    this.prompts.set(marker, prompt);
    if (!this.connect)
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const snapshot = await page.evaluate(async (marker) => {
      window.name = marker;
      const idOf = (el: Element) =>
        el
          .closest('[data-chatgpt-selection-message-id]')
          ?.getAttribute('data-chatgpt-selection-message-id') ??
        el
          .querySelector('[data-dil-source-message-id]')
          ?.getAttribute('data-dil-source-message-id') ??
        el.closest('[data-message-id]')?.getAttribute('data-message-id');
      let signedIn = false;
      try {
        const session = await fetch('/api/auth/session', {
          credentials: 'include',
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.json());
        signedIn = !!session?.accessToken;
      } catch {}
      return {
        userIds: Array.from(
          document.querySelectorAll(
            '[data-user-message-bubble], [data-message-author-role="user"]',
          ),
        )
          .map(idOf)
          .filter(Boolean) as string[],
        conversationId: location.pathname.match(/\/c\/([^/?]+)/)?.[1],
        loggedOut: !signedIn,
      };
    }, marker);
    if (snapshot.loggedOut)
      throw Error('Human login required in isolated Chrome profile; open ChatGPT and sign in');
    await page.locator(INPUT).last().fill(prompt, { timeout: 10000 });
    return { marker, baselineUserIds: snapshot.userIds, conversationId: snapshot.conversationId };
  }
  async clickSend(receipt: SendReceipt, onReceipt: (r: SendReceipt) => void) {
    const page = this.pages.get(receipt.marker);
    if (!page) throw Error('Prepared tab lost; never replay');
    const prompt = this.prompts.get(receipt.marker);
    let latest = { ...receipt };
    const submitted = (request: any) => {
      if (
        request.method() !== 'POST' ||
        !/^https:\/\/chatgpt\.com\/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(request.url())
      )
        return;
      try {
        const body = request.postDataJSON();
        const messages = body?.messages?.filter(
          (m: any) =>
            m.author?.role === 'user' &&
            Array.isArray(m.content?.parts) &&
            m.content.parts.every((p: any) => typeof p === 'string') &&
            m.content.parts.join('') === prompt,
        );
        if (
          messages?.length === 1 &&
          typeof messages[0].id === 'string' &&
          !receipt.baselineUserIds.includes(messages[0].id)
        ) {
          latest = {
            ...latest,
            userMessageId: messages[0].id,
            conversationId:
              body.conversation_id ??
              page.url().match(/\/c\/([^/?]+)/)?.[1] ??
              latest.conversationId,
          };
          onReceipt(latest);
        }
      } catch {}
    };
    page.on('request', submitted);
    // Keep the receipt listener alive after an ambiguous CDP error. A late network
    // receipt is journaled too, without performing a second input gesture.
    await page.locator(SEND).first().click({ timeout: 10000, noWaitAfter: true });
    return latest;
  }
  private async findPage(receipt: SendReceipt): Promise<Page> {
    const browser = await this.connected();
    const known = this.pages.get(receipt.marker);
    if (known && !(known as any).isClosed?.()) return known;
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        if (!page.url().startsWith('https://chatgpt.com/')) continue;
        const name = await page.evaluate(() => window.name).catch(() => null);
        if (
          name === receipt.marker ||
          (receipt.conversationId && page.url().includes(`/c/${receipt.conversationId}`))
        ) {
          this.pages.set(receipt.marker, page);
          return page;
        }
      }
    if (!receipt.conversationId)
      throw Error('Unknown tab without a conversation receipt; observe only, never replay');
    const page = await browser.contexts()[0].newPage();
    await page.goto(`https://chatgpt.com/c/${encodeURIComponent(receipt.conversationId)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    this.pages.set(receipt.marker, page);
    return page;
  }
  async read(receipt: SendReceipt): Promise<any> {
    const page = await this.findPage(receipt);
    const conversationId = receipt.conversationId ?? page.url().match(/\/c\/([^/?]+)/)?.[1];
    if (!conversationId) throw Error('Conversation URL not available yet');
    receipt.conversationId = conversationId;
    // Authentication is confined to the browser's existing session. Neither token
    // nor cookies ever return through CDP to Node, journals, Manager, or logs.
    return page.evaluate(async (id) => {
      const session = await fetch('/api/auth/session', {
        credentials: 'include',
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.json());
      if (!session?.accessToken) throw Error('Human login required');
      const response = await fetch(`/backend-api/conversation/${encodeURIComponent(id)}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error(`Conversation read ${response.status}`);
      return response.json();
    }, conversationId);
  }
  async close() {
    this.pages.clear();
    this.prompts.clear();
    this.loginPage = undefined;
    const browser = this.browser;
    this.browser = undefined;
    /* CDP Browser.close disconnects this client; Chrome and generation stay alive. */ await browser?.close();
  }
}
