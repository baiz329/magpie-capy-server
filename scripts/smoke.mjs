// 真实 smoke：本机 Capy 登录态 → /models → particle-1 "pong"。
// 运行前先 `bun run build`；需要本机已登录 Capy 桌面端。
import plugin from "../dist/index.mjs";

const capy = await plugin({}, {});
const method = capy.auth.methods[0];
const auth = await (await method.authorize()).callback();
if (auth?.type !== "success") throw new Error(`登录失败：${String(auth?.error ?? "unknown")}`);

const loader = await capy.auth.loader(async () => auth);
const models = await loader.fetch("https://api.capy.ai/api/v1/models").then((response) => response.json());
console.log(`models: ${models.data?.length ?? 0}`);

const started = Date.now();
const response = await loader.fetch("https://api.capy.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "particle/particle-1",
    stream: false,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
  }),
});
const text = await response.text();
console.log(`chat: ${response.status} ${Date.now() - started}ms`);
console.log(text.slice(0, 500));

process.exit(0);
