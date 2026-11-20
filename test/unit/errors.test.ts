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
