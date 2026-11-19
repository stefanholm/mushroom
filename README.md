# Mushroom Chat

Minimal web app that chats with the [Mistral API](https://docs.mistral.ai) using the official
[`@mistralai/mistralai`](https://www.npmjs.com/package/@mistralai/mistralai) TypeScript SDK.
The model is `mistral-small-latest`. The API key stays on the server (`MISTRAL_API_KEY` in
`.env`, never sent to the browser); the frontend only talks to the local `/api/chat` endpoint.

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env   # then edit .env and set your MISTRAL_API_KEY (from https://console.mistral.ai)
npm run dev            # starts on http://localhost:3000 (auto-reloads on changes)
```

Open http://localhost:3000 and start chatting.

Other commands:

```bash
npm start        # run without auto-reload
npm run typecheck
```

## How it works

- `src/server.ts` — Express server. Serves the static UI from `public/` and exposes
  `POST /api/chat`, which forwards the conversation to `client.chat.complete()` and returns
  `{ "reply": "..." }`.
- `public/index.html` — plain HTML/JS chat interface; keeps the conversation history in the
  browser and posts it to `/api/chat` on each message.
