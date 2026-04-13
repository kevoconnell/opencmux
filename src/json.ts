export type TJsonValue =
  | null
  | boolean
  | number
  | string
  | TJsonValue[]
  | { [key: string]: TJsonValue };

export type TJsonRecord = Record<string, TJsonValue>;

export function isJsonRecord(value: unknown): value is TJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
