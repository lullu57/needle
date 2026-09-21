export const MAX_REQUEST_BYTES = 512_000;
export function accessError(headers, env = process.env) {
  const token = env.NEEDLE_ACCESS_TOKEN?.trim();
  if (!token)
    return {
      status: 503,
      error: "Set NEEDLE_ACCESS_TOKEN on the server before searching.",
    };
  if (headers["x-needle-token"] !== token)
    return { status: 401, error: "Set the Needle access token in settings." };
  const contentType = headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json"
  )
    return { status: 415, error: "Send searches as application/json." };
  return null;
}
