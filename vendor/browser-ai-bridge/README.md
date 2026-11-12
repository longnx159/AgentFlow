# Pinned browser-ai-bridge source

Source: https://github.com/jeffrey-nz/browser-ai-bridge

Commit: `de112345daecaf6f2c6d480099de783da7873737`.

`locators.js` is the original `src/ai/chatgpt/locators.js`.
`dom.upstream.js` is the original `src/ai/chatgpt/interaction/prompt/dom.js`.
`LICENSE` is the original MIT license, copyright browser-ai-bridge contributors.

Agent Flow adapts the composer/send locators, message-ID DOM discovery, and page-context authenticated read technique in `src/worker/chrome.ts`. These original reference files are not executed. Agent Flow implements its own one-gesture durable send and strict submitted-user ancestry validation. It does not import the upstream retrying send helper, API server, poll timeout, DOM stability completion, cleanup, citation stripping, account/provider fallback, or extraction code.
