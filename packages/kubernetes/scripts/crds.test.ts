import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { parseAllDocuments } from "yaml";
import { crdSpec, groupPascal, type Crd } from "./crds.ts";

const fixtures = path.join(import.meta.dirname, "../test/fixtures");
const json = (file: string) => JSON.parse(readFileSync(path.join(fixtures, file), "utf8"));

/** The template path items and parameters, cut from the mirror's swagger.json. */
const base = json("crd-templates.json");
/** What a real API server publishes for the external-snapshotter CRDs. */
const served = json("snapshot-served.json");
const crds: Crd[] = readdirSync(path.join(fixtures, "crds")).flatMap((file) =>
  parseAllDocuments(readFileSync(path.join(fixtures, "crds", file), "utf8")).map((d) => d.toJS()),
);

/** The same summary as test/fixtures/snapshot-served.json, of a built fragment. */
const operations = (paths: Record<string, any>) => {
  const resolve = (p: any) => (p.$ref ? base.parameters[p.$ref.split("/").pop()] : p);
  const out: Record<string, unknown> = {};
  for (const [route, item] of Object.entries<any>(paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item[method];
      if (op === undefined) continue;
      out[`${method.toUpperCase()} ${route}`] = {
        operationId: op.operationId,
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])]
          .map(resolve)
          .map((p) => `${p.in}:${p.name}${p.in === "body" ? `=${p.schema.$ref}` : ""}`)
          .sort(),
        response: op.responses["200"].schema.$ref,
        ...(method === "patch" ? { consumes: op.consumes } : {}),
      };
    }
  }
  return out;
};

describe("crdSpec", () => {
  const built = crdSpec(base, crds);

  test("builds the operations the API server serves for the CRDs", () => {
    expect(operations(built.paths)).toEqual(served.operations);
  });

  test("defines each served kind and its list, and names nested objects by path", () => {
    expect(Object.keys(built.definitions)).toEqual(expect.arrayContaining(served.definitions));
    const snapshot = built.definitions["io.k8s.storage.snapshot.v1.VolumeSnapshot"];
    expect(snapshot.properties.metadata.$ref).toBe(
      "#/definitions/io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta",
    );
    expect(snapshot.properties.spec).toEqual({
      $ref: "#/definitions/io.k8s.storage.snapshot.v1.VolumeSnapshotSpec",
    });
    expect(
      built.definitions["io.k8s.storage.snapshot.v1.VolumeSnapshotSpec"].properties.source,
    ).toEqual({ $ref: "#/definitions/io.k8s.storage.snapshot.v1.VolumeSnapshotSpecSource" });
    expect(built.definitions["io.k8s.storage.snapshot.v1.VolumeSnapshotList"]).toMatchObject({
      required: ["items"],
      properties: {
        items: { items: { $ref: "#/definitions/io.k8s.storage.snapshot.v1.VolumeSnapshot" } },
      },
    });
  });

  test("skips versions the server does not serve", () => {
    expect(Object.keys(built.paths).some((p) => p.includes("/v1beta1/"))).toBe(false);
  });

  test("names groups like the API server", () => {
    expect(groupPascal("snapshot.storage.k8s.io")).toBe("SnapshotStorage");
    expect(groupPascal("cert-manager.io")).toBe("CertManagerIo");
  });

  test("refuses a manifest that is not a CRD", () => {
    expect(() => crdSpec(base, [{ ...crds[0]!, kind: "Deployment" }])).toThrow(
      /expected a CustomResourceDefinition/,
    );
  });
});
