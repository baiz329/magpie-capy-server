import { expect, test } from "bun:test";

import {
  CapyError,
  mapUpstream,
  toOpenAiError,
} from "../../src/domain/errors.ts";

test("mapUpstream：401/402/403/429/404", () => {
  expect(mapUpstream(401, { _tag: "capy/Unauthorized" }).kind).toBe("sign_in_required");
  expect(mapUpstream(402, { _tag: "capy/PaidFeatureUnavailable", message: "credits" }).kind).toBe("insufficient_quota");
  expect(mapUpstream(403, { _tag: "capy/Forbidden" }).status).toBe(403);
  expect(mapUpstream(429, { _tag: "capy/RateLimited" }).retryable).toBe(true);
  expect(mapUpstream(404, { _tag: "capy/ThreadNotFound" }).kind).toBe("not_found");
  expect(mapUpstream(404, { _tag: "capy/ModelNotFound" }).kind).toBe("model_not_found");
});

test("mapUpstream：ModelSelection.Rejected → 404", () => {
  const error = mapUpstream(400, { _tag: "ModelSelection.Rejected", message: "no" });
  expect(error.kind).toBe("model_not_found");
  expect(error.status).toBe(404);
});

test("toOpenAiError：形状/状态/type", () => {
  const body = toOpenAiError(new CapyError("sign_in_required", "login"));
  expect(body.error).toEqual({
    message: "login",
    type: "authentication_error",
    code: "sign_in_required",
    status: 401,
  });
  const upstream = toOpenAiError(new CapyError("upstream_unavailable", "down"));
  expect(upstream.error.type).toBe("upstream_error");
  expect(upstream.error.status).toBe(503);
  const invalid = toOpenAiError(new CapyError("invalid_request", "bad"));
  expect(invalid.error.type).toBe("invalid_request_error");
});

test("mapUpstream：429 带 retryAfterMs 才进 CapyError（M-14 死代码消除）", () => {
  const withAfter = mapUpstream(429, { _tag: "capy/RateLimited" }, "", 5000);
  expect(withAfter.kind).toBe("rate_limited");
  expect(withAfter.retryAfterMs).toBe(5000);
  const without = mapUpstream(429, { _tag: "capy/RateLimited" });
  expect(without.retryAfterMs).toBeUndefined();
});

test("mapUpstream：403 body 码 region_unsupported → region_unsupported（M-14）", () => {
  const error = mapUpstream(403, { _tag: "capy/Forbidden", code: "region_unsupported", message: "only US" });
  expect(error.kind).toBe("region_unsupported");
  expect(error.status).toBe(403);
  expect(mapUpstream(403, { _tag: "capy/Forbidden" }).kind).toBe("upstream_error");
});

test("retryAfterSeconds：429 的毫秒向上取整；无值/非 CapyError → null", async () => {
  const { retryAfterSeconds } = await import("../../src/domain/errors.ts");
  expect(retryAfterSeconds(new CapyError("rate_limited", "slow", { retryAfterMs: 2500 }))).toBe(3);
  expect(retryAfterSeconds(new CapyError("rate_limited", "slow", { retryAfterMs: 0 }))).toBe(0);
  expect(retryAfterSeconds(new CapyError("rate_limited", "slow"))).toBeNull();
  expect(retryAfterSeconds(new Error("boom"))).toBeNull();
});
