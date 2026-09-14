type BeforeQuitHandler = () => Promise<void>;

let handler: BeforeQuitHandler | undefined;

export function registerBeforeQuitHandler(next: BeforeQuitHandler) {
  handler = next;
  return () => { if (handler === next) handler = undefined; };
}

export async function preparePendingChangesForQuit() {
  await handler?.();
}
