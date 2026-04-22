export const resolveUpstreamUrl = (baseUrl: string, path?: string) => {
  const trimmedBase = baseUrl.trim();
  const trimmedPath = (path ?? "").trim();

  if (trimmedPath.startsWith("http://") || trimmedPath.startsWith("https://")) {
    return trimmedPath;
  }
  if (!trimmedBase) {
    throw new Error("Missing upstream baseUrl");
  }
  if (!trimmedPath || trimmedPath === "/") {
    return trimmedBase;
  }
  return new URL(trimmedPath, trimmedBase).toString();
};
