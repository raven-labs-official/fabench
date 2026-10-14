/** Registry JSON must be an object; a corrupt record is not missing metadata. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRegistryObject<T extends object>(
  raw: string,
  context: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${context}: invalid JSON`, { cause: error });
  }
  if (!isJsonObject(value))
    throw new Error(`${context}: expected a JSON object`);
  return value as T;
}
