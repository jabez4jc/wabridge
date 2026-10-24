import { expect, test } from "bun:test";
import { closeAction, nextRetryMs } from "../src/socket";

test("close handling", () => {
  expect(closeAction(440, true)).toBe("replaced");
  expect(closeAction(401, true)).toBe("logged_out");
  expect(closeAction(408, false)).toBe("unlinked");
  expect(closeAction(515, true)).toBe("disconnected");
  expect(closeAction(undefined, true)).toBe("disconnected");
});

test("backoff doubles to 60s", () => {
  const seq = [3000];
  while (seq.length < 7) seq.push(nextRetryMs(seq.at(-1)!));
  expect(seq).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000]);
});
