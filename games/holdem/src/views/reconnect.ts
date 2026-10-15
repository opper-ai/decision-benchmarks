// "Reconnecting…": a calm line at the top of the room while RemoteDriver tries a request again (onConnection), with a
// spinner and the countdown to the next try; the table stays as it was under it. Gone when the table answers.
import { h } from '../dom.ts';
import { retryLine } from '../reconnect.ts';
import type { ConnectionEvent } from '../remote-driver.ts';

export function reconnectBanner(signal: AbortSignal): { el: HTMLElement; update(e: ConnectionEvent): void } {
  // The countdown is for the eye; a screen reader hears "Reconnecting…" once.
  const when = h('span.reconnect-when', { 'aria-hidden': 'true' });
  const el = h('div.reconnect', { role: 'status', hidden: true }, h('span.spin', { 'aria-hidden': 'true' }), h('b', null, 'Reconnecting…'), when);
  let next = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => (when.textContent = retryLine(next - Date.now()));
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  signal.addEventListener('abort', stop, { once: true });
  return {
    el,
    update(e) {
      if (signal.aborted) return;
      if (e.state === 'ok') {
        stop();
        el.hidden = true;
        return;
      }
      next = Date.now() + e.nextInMs;
      el.title = e.error;
      el.hidden = false;
      tick();
      timer ??= setInterval(tick, 250);
    },
  };
}
