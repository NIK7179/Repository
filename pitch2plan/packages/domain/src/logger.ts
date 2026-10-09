export interface Logger {
  info(fields: Record<string, unknown>, msg?: string): void;
  warn(fields: Record<string, unknown>, msg?: string): void;
  error(fields: Record<string, unknown>, msg?: string): void;
}
export const noopLogger: Logger = { info() {}, warn() {}, error() {} };
