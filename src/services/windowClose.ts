/** 关闭到托盘与真正退出共用入口，保证退出前保存且不重复执行。 */
export function createWindowCloseController(deps: {
  trayOnly: () => boolean;
  hide: () => Promise<void>;
  save: () => Promise<void>;
  close: () => Promise<void>;
  failed: () => Promise<void>;
}) {
  let busy = false;
  let allowClose = false;
  async function request(quit = false) {
    if (busy) return;
    busy = true;
    try {
      if (!quit && deps.trayOnly()) await deps.hide();
      else {
        await deps.save();
        allowClose = true;
        await deps.close();
      }
    } catch {
      allowClose = false;
      await deps.failed();
    } finally { busy = false; }
  }
  return {
    request,
    onCloseRequested(event: { preventDefault: () => void }) {
      if (allowClose) return;
      event.preventDefault();
      return request();
    },
  };
}
