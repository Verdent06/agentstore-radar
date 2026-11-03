import { describe, expect, it } from "vitest";
import { isScopedNpmPackage, npmBulkUrl, partitionNpmDownloads } from "../src/adapters/npm.ts";
import { NPM_BULK_LIMIT } from "../src/lib/config.ts";

describe("npm bulk batching", () => {
  it("puts unscoped names in batches of 128 and keeps scoped packages individual", () => {
    const unscoped = Array.from({ length: NPM_BULK_LIMIT + 10 }, (_, index) => `pkg-${index}`);
    const scoped = ["@scope/one", "@other/two", "@scope/three"];
    const mixed = [...unscoped.slice(0, 50), scoped[0]!, ...unscoped.slice(50), scoped[1]!, scoped[2]!];
    const split = partitionNpmDownloads(mixed);

    expect(split.scoped).toEqual(scoped);
    expect(split.bulk).toHaveLength(2);
    expect(split.bulk[0]).toHaveLength(NPM_BULK_LIMIT);
    expect(split.bulk[1]).toHaveLength(10);
    expect(split.bulk.flat().some(isScopedNpmPackage)).toBe(false);

    const url = npmBulkUrl(split.bulk[0]!);
    expect(url).toBe(
      `https://api.npmjs.org/downloads/point/last-week/${split.bulk[0]!.join(",")}`,
    );
    expect(url).not.toContain("@");
    expect(npmBulkUrl(["@scope/one"])).toContain("@scope/one");
  });
});
