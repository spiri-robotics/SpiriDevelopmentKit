import { Config, ConsolidationMode, Duration, Sample, open } from "@eclipse-zenoh/zenoh-ts";

// Zenoh from the browser. zenoh-ts talks to a remote-api bridge over a
// websocket (Caddy's /zenoh), which is a zenoh client of the SDK router.
//
// The session opens on first use. zenoh-ts doesn't say when its websocket
// drops, so a heartbeat notices, and every subscription is declared again
// once a new session is up. Fires "status" when `status` changes.

const HEARTBEAT_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error("timed out")))]);
}

// Whether a websocket to url opens.
function reachable(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (ok) => {
      clearTimeout(timer);
      ws.onopen = ws.onerror = null;
      ws.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 3000);
    ws.onopen = () => done(true);
    ws.onerror = () => done(false);
  });
}

export class Zenoh extends EventTarget {
  #url;
  #session = null;
  #opening = null;
  #subs = new Set();
  status = "idle";

  constructor(url) {
    super();
    this.#url = url;
  }

  #setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.dispatchEvent(new Event("status"));
  }

  // The open session, opening it (and retrying until it opens) if needed.
  session() {
    if (this.#session) return Promise.resolve(this.#session);
    this.#opening ??= (async () => {
      this.#setStatus("connecting");
      let session;
      for (;;) {
        try {
          // zenoh-ts retries by itself, but doubles its wait every time, so
          // only hand it a bridge that's answering.
          if (await reachable(this.#url)) {
            session = await open(new Config(this.#url));
            break;
          }
        } catch (e) {
          console.warn("zenoh: can't open session", e);
        }
        await sleep(2000);
      }
      this.#session = session;
      this.#opening = null;
      this.#setStatus("up");
      this.#heartbeat(session);
      for (const sub of this.#subs) this.#declare(session, sub);
      return session;
    })();
    return this.#opening;
  }

  // Two missed pings in a row count as lost: one can just be stuck behind
  // a burst of traffic.
  async #heartbeat(session) {
    let missed = 0;
    while (session === this.#session) {
      await sleep(HEARTBEAT_MS);
      if (session !== this.#session) return;
      try {
        await withTimeout(session.info(), HEARTBEAT_MS);
        missed = 0;
      } catch {
        if (++missed < 2) continue;
        console.warn("zenoh: session lost, reconnecting");
        this.#session = null;
        for (const sub of this.#subs) sub.subscriber = null;
        this.#setStatus("down");
        session.close().catch(() => {});
        this.session();
        return;
      }
    }
  }

  // Every reply to a query: Samples, or Errors for error replies. onReply,
  // if given, sees each one as it arrives. Replies aren't consolidated, so
  // several from one key (a SpiriSynq generator) all arrive.
  async query(selector, { payload, timeoutMs = 3000, onReply } = {}) {
    const session = await this.session();
    return new Promise((resolve, reject) => {
      const replies = [];
      session
        .get(selector, {
          payload,
          consolidation: ConsolidationMode.NONE,
          timeout: Duration.milliseconds.of(timeoutMs),
          handler: [
            (reply) => {
              const r = reply.result();
              const result = r instanceof Sample ? r : new Error(r.payload().toString());
              replies.push(result);
              onReply?.(result);
            },
            () => resolve(replies),
          ],
        })
        .catch(reject);
    });
  }

  async #declare(session, sub) {
    try {
      const subscriber = await session.declareSubscriber(sub.key, { handler: sub.handler });
      if (session === this.#session && this.#subs.has(sub)) sub.subscriber = subscriber;
      else subscriber.undeclare().catch(() => {});
    } catch (e) {
      console.warn(`zenoh: can't subscribe to ${sub.key}`, e);
    }
  }

  // Calls handler(sample) for every sample on key, across reconnects.
  // Returns a function that unsubscribes.
  subscribe(key, handler) {
    const sub = { key, handler, subscriber: null };
    this.#subs.add(sub);
    if (this.#session) this.#declare(this.#session, sub);
    else this.session();
    return () => {
      this.#subs.delete(sub);
      sub.subscriber?.undeclare().catch(() => {});
    };
  }
}
