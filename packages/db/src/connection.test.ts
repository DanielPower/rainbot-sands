import { describe, expect, it } from "vitest";
import { pgConnectionString } from "./connection.ts";

describe("pgConnectionString", () => {
  it("uses libpq semantics for sslmode=require", () => {
    const result = new URL(
      pgConnectionString("postgresql://user:pass@example.com/database?sslmode=require"),
    );

    expect(result.searchParams.get("sslmode")).toBe("require");
    expect(result.searchParams.get("uselibpqcompat")).toBe("true");
  });

  it("preserves certificate-verifying SSL modes", () => {
    const result = new URL(
      pgConnectionString("postgresql://user:pass@example.com/database?sslmode=verify-full"),
    );

    expect(result.searchParams.get("sslmode")).toBe("verify-full");
    expect(result.searchParams.has("uselibpqcompat")).toBe(false);
  });

  it("preserves an explicit compatibility choice", () => {
    const result = new URL(
      pgConnectionString(
        "postgresql://user:pass@example.com/database?sslmode=require&uselibpqcompat=false",
      ),
    );

    expect(result.searchParams.get("uselibpqcompat")).toBe("false");
  });
});
