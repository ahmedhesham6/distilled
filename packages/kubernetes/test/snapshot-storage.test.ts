import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { describe, expect, test } from "vitest";
import { fromToken } from "../src/credentials.ts";
import * as Kubernetes from "../src/index.ts";
import * as Retry from "../src/retry.ts";

/** Run `effect` against a fake API server that answers `reply`. */
const call = async <A, E, R>(effect: Effect.Effect<A, E, R>, reply: unknown) => {
  let request: HttpClientRequest.HttpClientRequest | undefined;
  const client = HttpClient.make((req) =>
    Effect.sync(() => {
      request = req;
      return HttpClientResponse.fromWeb(req, new Response(JSON.stringify(reply)));
    }),
  );
  const result = await Effect.runPromise(
    effect.pipe(
      Retry.none,
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          fromToken({ token: Redacted.make("t"), apiBaseUrl: "https://k8s.test" }),
        ),
      ),
    ) as Effect.Effect<A, E>,
  );
  const web = Result.getOrThrow(HttpClientRequest.toWebResult(request!));
  return { result, web, body: await web.text() };
};

const snapshot = {
  apiVersion: "snapshot.storage.k8s.io/v1",
  kind: "VolumeSnapshot",
  metadata: { name: "data-snap", namespace: "default" },
  spec: {
    volumeSnapshotClassName: "csi-snapclass",
    source: { persistentVolumeClaimName: "data" },
  },
};

describe("snapshot.storage.k8s.io/v1 (a CRD group)", () => {
  test("creates a VolumeSnapshot", async () => {
    const { result, web, body } = await call(
      Kubernetes.snapshot_storage.createSnapshotStorageV1NamespacedVolumeSnapshot({
        namespace: "default",
        ...snapshot,
      }),
      snapshot,
    );
    expect(web.method).toBe("POST");
    expect(web.url).toBe(
      "https://k8s.test/apis/snapshot.storage.k8s.io/v1/namespaces/default/volumesnapshots",
    );
    expect(JSON.parse(body)).toEqual(snapshot);
    expect(result.spec.source.persistentVolumeClaimName).toBe("data");
  });

  test("lists cluster-scoped VolumeSnapshotClasses", async () => {
    const { result, web } = await call(
      Kubernetes.snapshot_storage.listSnapshotStorageV1VolumeSnapshotClass({ limit: 10 }),
      {
        apiVersion: "snapshot.storage.k8s.io/v1",
        kind: "VolumeSnapshotClassList",
        metadata: {},
        items: [
          {
            metadata: { name: "csi-snapclass" },
            driver: "hostpath.csi.k8s.io",
            deletionPolicy: "Delete",
          },
        ],
      },
    );
    expect(web.url).toBe(
      "https://k8s.test/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses?limit=10",
    );
    expect(result.items[0]?.driver).toBe("hostpath.csi.k8s.io");
  });

  test("patches a VolumeSnapshot with a merge patch", async () => {
    const { web, body } = await call(
      Kubernetes.snapshot_storage.patchSnapshotStorageV1NamespacedVolumeSnapshot({
        namespace: "default",
        name: "data-snap",
        body: { metadata: { labels: { keep: "yes" } } },
      }),
      snapshot,
    );
    expect(web.method).toBe("PATCH");
    expect(web.headers.get("content-type")).toBe("application/merge-patch+json");
    expect(JSON.parse(body)).toEqual({ metadata: { labels: { keep: "yes" } } });
  });
});
