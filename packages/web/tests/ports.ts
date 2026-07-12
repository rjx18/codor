// harn:assume playwright-spec-files-use-isolated-daemons ref=isolated-e2e-spec-ports
function readPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

export const API_PORT = readPort('CODOR_E2E_API_PORT', 18_137);
export const CONTROL_PORT = readPort('CODOR_E2E_CONTROL_PORT', 18_138);
export const BASE = `http://127.0.0.1:${String(API_PORT)}`;
export const CONTROL = `http://127.0.0.1:${String(CONTROL_PORT)}`;
// harn:end playwright-spec-files-use-isolated-daemons
