# DropLeaf

A private cross-device clipboard for text and files. Edits sync to a shared draft. Saving archives the current draft and starts a blank one.

DropLeaf is based on [Clip9](https://github.com/Jonnyan404/clip9) by jonnyan404 and distributed under the [MIT License](LICENSE).

The React frontend is served by a Cloudflare Worker. D1 stores drafts and history, R2 holds attachments, and a SQLite Durable Object distributes live updates over WebSocket.

## Build and test

~~~sh
npm ci --prefix web
npm ci --prefix cloudflare/workers
node scripts/build.mjs
npm test --prefix cloudflare/workers
~~~

## Deployment

Use Cloudflare Workers Builds with `cloudflare/workers` as the root directory. Build with `cd ../.. && npm ci --prefix web && npm ci --prefix cloudflare/workers && node scripts/build.mjs`. Deploy with `npm run deploy`.

For a new instance, replace the D1 and R2 bindings with your own resources and initialize D1 with `cloudflare/d1/schema.sql` followed by `cloudflare/d1/002-draft.sql`. Set `AUTH_PASSWORD` and `ROOM_SESSION_SECRET` as Worker runtime secrets. Use independently generated values. Production requires both.
