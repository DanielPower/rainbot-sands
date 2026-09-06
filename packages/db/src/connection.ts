export function pgConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  if (
    url.searchParams.get("sslmode")?.toLowerCase() === "require" &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}
