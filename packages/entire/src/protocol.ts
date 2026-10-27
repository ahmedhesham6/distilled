import type * as API from "@distilled.cloud/core/api";
import type { ConfigError, InvalidInput } from "@distilled.cloud/core/errors";
import { HTTP_STATUS_MAP } from "@distilled.cloud/core/errors";
import { makeRestProtocol, type RestErrorEnvelope } from "@distilled.cloud/core/protocol-rest";
/**
 * Entire protocols -- the shared bearer-REST protocol instantiated once per
 * Entire API.
 *
 * Entire speaks plain JSON with no success envelope, and every request
 * carries `Authorization: Bearer <token>`. The two APIs live on different
 * hosts under the same `/api/v1` root, so each generated operation binds the
 * protocol for its API:
 *
 *   * {@link EntireCoreProtocol} -- the Core control plane (`coreBaseUrl`)
 *   * {@link EntireCellProtocol} -- the regional cell (`apiBaseUrl`)
 *
 * Failures are RFC 9457 problem documents (`{ status, title, detail,
 * errors? }`); {@link errorEnvelope} reads `detail` (falling back to `title`)
 * as the message, and the HTTP status picks the error class.
 */
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Credentials, type Config } from "./credentials.ts";
import {
  EntireParseError,
  Gone,
  MisdirectedRequest,
  PayloadTooLarge,
  PreconditionFailed,
  PreconditionRequired,
  UnknownEntireError,
  type DefaultErrors,
} from "./errors.ts";

/**
 * Error channel shared by every generated Entire operation. Generated
 * service files annotate operations with `API.OperationMethod<I, O,
 * EntireOpError, EntireOpContext>` explicitly so the compiler never infers
 * these back out of the schema generics.
 */
export type EntireOpError =
  | DefaultErrors
  | ConfigError
  | HttpClientError.HttpClientError
  | InvalidInput;

/** Context (requirements) shared by every generated Entire operation. */
export type EntireOpContext = Credentials | HttpClient.HttpClient;

/**
 * `{ code?, message? }` from a problem document. `detail` is the
 * occurrence-specific explanation; `title` is the status's generic summary.
 * Field-level validation failures add `errors[].message`, appended so a 422
 * names the offending field.
 */
const errorEnvelope = (body: unknown): RestErrorEnvelope | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const detail = typeof b.detail === "string" ? b.detail : undefined;
  const title = typeof b.title === "string" ? b.title : undefined;
  const fieldErrors = Array.isArray(b.errors)
    ? b.errors.flatMap((e) =>
        e !== null && typeof e === "object" && typeof (e as any).message === "string"
          ? [
              typeof (e as any).location === "string"
                ? `${(e as any).location}: ${(e as any).message}`
                : (e as any).message,
            ]
          : [],
      )
    : [];
  const message =
    [detail ?? title, ...fieldErrors].filter((m) => m !== undefined).join("; ") || undefined;
  return { code: title, message };
};

const statusMap = {
  ...HTTP_STATUS_MAP,
  410: Gone,
  412: PreconditionFailed,
  413: PayloadTooLarge,
  421: MisdirectedRequest,
  428: PreconditionRequired,
};

const make = (baseUrl: (creds: Config) => string): Layer.Layer<API.Protocol> =>
  makeRestProtocol<Config>({
    // Resolved on the CALLING fiber per request (the layer is memoized per
    // process); the Credentials service holds an effect, so a token
    // refreshed between calls is picked up without rebuilding the layer.
    credentials: Effect.flatMap(Credentials, (resolve) => resolve),
    baseUrl,
    headers: (creds) => ({
      Authorization: `Bearer ${Redacted.value(creds.token)}`,
    }),
    errorEnvelope,
    statusMap,
    unknownError: ({ code, message, body }) =>
      new UnknownEntireError({
        code: typeof code === "string" ? code : code !== undefined ? String(code) : undefined,
        message,
        body,
      }),
    parseError: ({ body, cause }) => new EntireParseError({ body, cause }),
  });

/** The Core control-plane protocol (`coreBaseUrl`). */
export const EntireCoreProtocol: Layer.Layer<API.Protocol> = /*@__PURE__*/ make(
  (creds) => creds.coreBaseUrl,
);

/** The regional cell protocol (`apiBaseUrl`). */
export const EntireCellProtocol: Layer.Layer<API.Protocol> = /*@__PURE__*/ make(
  (creds) => creds.apiBaseUrl,
);
