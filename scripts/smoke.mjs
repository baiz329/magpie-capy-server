// 真实 smoke：本机 Capy 登录态 → /models → particle-1 "pong"。
// 运行前先 `bun run build`；需要本机已登录 Capy 桌面端。
// 断言（T-04）：models 数 >0、chat 2xx、回复文本非空；任一失败 exit 非 0。
import plugin from "../dist/index.mjs";

function fail(message) {
  console.error(`smoke 失败：${message}`);
  process.exit(1);
}

try {
  const capy = await plugin({}, {});
  const method = capy.auth.methods[0];
  const auth = await (await method.authorize()).callback();
  if (auth?.type !== "success") fail(`登录失败：${String(auth?.error ?? "unknown")}`);

  const loader = await capy.auth.loader(async () => auth);
  const modelsRes = await loader.fetch("https://api.capy.ai/api/v1/models");
  if (!modelsRes.ok) fail(`models 非 2xx：${modelsRes.status}`);
  const models = await modelsRes.json();
  const count = Array.isArray(models.data) ? models.data.length : 0;
  console.log(`models: ${count}`);
  if (count <= 0) fail("models 数为 0");

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
  if (response.status < 200 || response.status >= 300) fail(`chat 非 2xx：${response.status}`);
  let content = "";
  try {
    content = JSON.parse(text).choices?.[0]?.message?.content ?? "";
  } catch {
    fail("chat 响应不是合法 JSON");
  }
  if (!String(content).trim()) fail("chat 文本为空");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

process.exit(0);
