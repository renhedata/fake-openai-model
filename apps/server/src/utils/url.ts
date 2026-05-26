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

/** Join baseUrl (ending at /v1) with a relative path segment (no leading /).
 *  e.g. joinUrl("https://api.kimi.com/coding/v1", "models")
 *       → "https://api.kimi.com/coding/v1/models"
 */
export const joinUrl = (baseUrl: string, path: string): string => {
  const base = baseUrl.trim().replace(/\/$/, "");
  const segment = path.trim().replace(/^\//, "");
  if (!base) throw new Error("Missing upstream baseUrl");
  return `${base}/${segment}`;
};
