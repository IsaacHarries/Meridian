import { vi } from "vitest";

export const invoke = vi.fn().mockResolvedValue(null);

export function mockInvoke(returnValue: unknown) {
  invoke.mockResolvedValueOnce(returnValue);
}
