"""zenoh-index: what's on zenoh, for browsers that can't take all of it.

Subscribes to `**` next to the router and keeps each key's latest sample,
message count, size and a short text preview. Browsers ask for summaries and
for one key's value at a time, so what crosses their websocket depends on
what they look at, not on how much is published.

    @sdk/index?since=<rev>   keys changed since rev, as JSON:
                             {"epoch", "rev", "keys": [[key, encoding, size,
                             count, preview or null, deleted, rate,
                             problem or null], ...]}
                             Counts are cumulative; rate is messages per
                             second over the last second. Also "objects":
                             {topic: [YAML tags]}, every SpiriSynq object
                             found by discovery, when that has changed since
                             rev. A key under an object whose value doesn't
                             fit the object's schema has a problem: why not.
                             since=0 (or none) is
                             everything; a new epoch means the index
                             restarted and the client should start over.
    @sdk/index/value         payload: a key. Replies with its latest value,
                             in its own encoding, with the key's count as the
                             attachment. No reply if it has none. A Gazebo
                             topic's value is decoded to JSON.
    @sdk/index/watch         payload: a Gazebo topic's key. Receive its
                             messages for the next WATCH_FOR seconds; ask
                             again to keep them coming.

Gazebo's topics are keys too, `@/<partition>@/<topic>`, listed from their
publishers' liveliness tokens with their message type as the encoding.
They only count messages while watched; see gz.py for why.

`@` keys are only matched exactly, so these never show up in `**`.
"""

import json
import os
import re
import threading
import time
import uuid

import yaml
import zenoh

import gz
from check import Checker

ROUTER = os.environ.get("ZENOH_ROUTER", "tcp/zenoh-router:7447")
PREVIEW = 120  # characters of text kept per key
PREVIEW_MAX = 4096  # bytes; longer values get no preview
FORGET_AFTER = 300  # seconds a deleted key is remembered
DISCOVER_EVERY = 5  # seconds between SpiriSynq discoveries
CHECK_MAX = 1 << 20  # bytes; bigger values aren't checked against schemas
WATCH_FOR = 10  # seconds a Gazebo topic is received after it was last asked for
TEXT = re.compile(r"^(application/(yaml|json|json5|xml)|text/|zenoh/string)")


class Key:
    __slots__ = ("sample", "encoding", "size", "count", "preview", "deleted", "rev", "rated", "rate", "problem", "gz")

    def __init__(self):
        self.sample = self.preview = self.problem = self.gz = None
        self.encoding = ""
        self.size = self.count = self.rated = self.deleted = 0
        self.rate = 0.0


class Index:
    def __init__(self):
        self.lock = threading.Lock()
        self.keys: dict[str, Key] = {}
        self.rev = 0
        self.epoch = uuid.uuid4().hex[:8]
        self.objects: dict[str, list[str]] = {}
        self.objects_rev = 0
        # Each object's owner and classes as last discovered, and a Checker
        # for its schema (None or False if it has no usable one).
        self.owners: dict[str, tuple] = {}
        self.checkers: dict[str, Checker | None | bool] = {}
        # Gazebo topics by key: the liveliness tokens of their publishers, and
        # while watched, (lease expiry, subscriber, our subscriber token).
        self.gz_publishers: dict[str, set[str]] = {}
        self.gz_watches: dict[str, tuple] = {}

    def on_sample(self, sample: zenoh.Sample):
        key = str(sample.key_expr)
        with self.lock:
            self.rev += 1
            if sample.kind == zenoh.SampleKind.DELETE:
                self._delete(key)
                return
            k = self.keys.get(key)
            if k is None:
                k = self.keys[key] = Key()
            k.sample = sample  # a reference; nothing is copied
            k.size = len(sample.payload)
            k.count += 1
            k.deleted = 0
            k.rev = self.rev
            k.preview = None
            if k.gz:
                if k.size <= PREVIEW_MAX:
                    k.preview = json.dumps(json.loads(gz.decode(k.gz, sample.payload.to_bytes())), separators=(",", ":"))[:PREVIEW]
                return
            k.encoding = str(sample.encoding)
            if TEXT.match(k.encoding) and k.size <= PREVIEW_MAX:
                text = sample.payload.to_bytes().decode("utf-8", "replace")
                k.preview = " ".join(text.split())[:PREVIEW]
            k.problem = self._check(key, k)

    # The object a key is a field of, and the field's path within it.
    def _owner(self, key: str):
        chunks = key.split("/")
        for i in range(len(chunks) - 1, 0, -1):
            topic = "/".join(chunks[:i])
            if topic in self.checkers:
                return topic, chunks[i:]
        return None, None

    # What's wrong with a key's latest value, by its object's schema.
    def _check(self, key: str, k: Key) -> str | None:
        topic, field = self._owner(key)
        checker = topic and self.checkers[topic]
        if not checker or k.size > CHECK_MAX:
            return None
        try:
            return checker.check(field, k.encoding, k.sample.payload.to_bytes())
        except Exception as e:
            return f"couldn't check: {e}"

    # One key, or `prefix/**`; other wildcard deletes aren't followed.
    def _delete(self, key: str):
        now = time.monotonic()
        if key.endswith("/**"):
            prefix = key[:-2]
            hit = [k for name, k in self.keys.items() if name.startswith(prefix) or name == key[:-3]]
        else:
            hit = [self.keys[key]] if key in self.keys else []
        for k in hit:
            if not k.deleted:
                k.deleted = now
                k.rev = self.rev

    # A gz publisher's liveliness token, coming or going. A topic is a key
    # while anything publishes it.
    def on_gz_token(self, sample: zenoh.Sample):
        token = str(sample.key_expr)
        parsed = gz.parse_token(token)
        if not parsed or parsed[0] != "MP":
            return
        _, partition, topic, msg_type = parsed
        key = gz.key(partition, topic)
        with self.lock:
            publishers = self.gz_publishers.setdefault(key, set())
            if sample.kind == zenoh.SampleKind.DELETE:
                publishers.discard(token)
                if not publishers:
                    del self.gz_publishers[key]
                    self.rev += 1
                    self._delete(key)
                return
            publishers.add(token)
            k = self.keys.get(key)
            if k is None or k.deleted or k.gz != msg_type:
                if k is None:
                    k = self.keys[key] = Key()
                self.rev += 1
                k.gz = k.encoding = msg_type
                k.deleted = 0
                k.rev = self.rev

    # Receive a Gazebo topic for the next WATCH_FOR seconds, by subscribing
    # to it the way a gz node does.
    def watch(self, session: zenoh.Session, key: str) -> bool:
        with self.lock:
            k = self.keys.get(key)
            if not k or not k.gz or k.deleted:
                return False
            watch = self.gz_watches.get(key)
            if watch:
                self.gz_watches[key] = (time.monotonic() + WATCH_FOR, *watch[1:])
                return True
            msg_type = k.gz
        partition, topic = key[2:].split("@", 1)
        subscriber = session.declare_subscriber(key, self.on_sample)
        token = session.liveliness().declare_token(gz.subscriber_token(partition, topic, msg_type))
        with self.lock:
            self.gz_watches[key] = (time.monotonic() + WATCH_FOR, subscriber, token)
        print(f"zenoh-index: watching {key}", flush=True)
        return True

    def unwatch_expired(self):
        now = time.monotonic()
        with self.lock:
            expired = [key for key, (until, *_) in self.gz_watches.items() if until < now]
            handles = [self.gz_watches.pop(key) for key in expired]
        for _, subscriber, token in handles:
            token.undeclare()
            subscriber.undeclare()
        for key in expired:
            print(f"zenoh-index: stopped watching {key}", flush=True)

    def summary(self, since: int) -> bytes:
        with self.lock:
            changed = [
                [name, k.encoding, k.size, k.count, k.preview, bool(k.deleted), k.rate, k.problem]
                for name, k in self.keys.items()
                if k.rev > since
            ]
            rev = self.rev
            reply = {"epoch": self.epoch, "rev": rev, "keys": changed}
            if self.objects_rev > since:
                reply["objects"] = self.objects
        return json.dumps(reply, separators=(",", ":")).encode()

    # SpiriSynq objects answer `<topic>/sr_metadata` (docs/protocol.md in
    # SpiriSynq). They're queryables, so `**` never sees them.
    # An object's schema is fetched when it's first found, and again when its
    # classes or owning node change (a restart may bring new code).
    def discover(self, session: zenoh.Session):
        owners = {}
        for reply in session.get("**/sr_metadata", consolidation=zenoh.ConsolidationMode.NONE, timeout=3):
            if not reply.ok:
                continue
            try:
                meta = yaml.safe_load(reply.ok.payload.to_string())
                owners[meta["topic"]] = (tuple(sorted(meta.get("classes") or [])), meta.get("authoritive_node"))
            except Exception as e:
                print(f"zenoh-index: bad sr_metadata from {reply.ok.key_expr}: {e}", flush=True)
        new = {t: self._checker(session, t) for t, o in owners.items() if self.owners.get(t) != o}
        with self.lock:
            gone = [t for t in self.checkers if t not in owners]
            for t in gone:
                del self.checkers[t]
            self.checkers.update(new)
            # A schema that couldn't be had is asked for again next time.
            self.owners = {t: o for t, o in owners.items() if new.get(t) is not False}
            # Values already here are judged again by the new schemas.
            if new or gone:
                for name, k in self.keys.items():
                    topic, _ = self._owner(name)
                    if topic in new or any(name.startswith(t + "/") for t in gone):
                        problem = self._check(name, k)
                        if problem != k.problem:
                            k.problem = problem
                            self.rev += 1
                            k.rev = self.rev
            objects = {t: list(o[0]) for t, o in owners.items()}
            if objects != self.objects:
                self.objects = objects
                self.rev += 1
                self.objects_rev = self.rev

    # A Checker, None for a schema too old to check with, or False if there
    # was no schema to be had.
    def _checker(self, session: zenoh.Session, topic: str) -> Checker | None | bool:
        try:
            reply = next(iter(session.get(f"{topic}/sr_object_schema", timeout=3))).ok
            schema = yaml.safe_load(reply.payload.to_string())
        except Exception as e:
            print(f"zenoh-index: no schema for {topic}: {e}", flush=True)
            return False
        # Schemas before format 2 (SpiriSynq 0.3) aren't valid JSON Schema.
        return Checker(schema) if schema.get("x-spirisynq-schema") else None

    # Each key's rate over the last `secs` seconds. A rate that moves is a
    # change, so the next summary carries it.
    def rates(self, secs: float):
        with self.lock:
            for k in self.keys.values():
                rate = round((k.count - k.rated) / secs, 1)
                k.rated = k.count
                if rate != k.rate:
                    k.rate = rate
                    self.rev += 1
                    k.rev = self.rev

    def forget(self):
        old = time.monotonic() - FORGET_AFTER
        with self.lock:
            for name in [n for n, k in self.keys.items() if k.deleted and k.deleted < old]:
                del self.keys[name]


def main():
    conf = zenoh.Config()
    conf.insert_json5("mode", '"client"')
    conf.insert_json5("connect/endpoints", json.dumps([ROUTER]))
    conf.insert_json5("scouting/multicast/enabled", "false")
    session = zenoh.open(conf)
    index = Index()

    def on_summary(query: zenoh.Query):
        try:
            since = int(query.parameters.get("since") or 0)
        except ValueError:
            return query.reply_err("since must be an integer")
        query.reply(query.key_expr, index.summary(since), encoding=zenoh.Encoding.APPLICATION_JSON)

    def on_value(query: zenoh.Query):
        key = query.payload.to_string() if query.payload else ""
        with index.lock:
            k = index.keys.get(key)
            sample = k and k.sample
            count = k and k.count
        if sample is None:
            return
        if k.gz:
            payload = gz.decode(k.gz, sample.payload.to_bytes())
            query.reply(query.key_expr, payload, encoding=zenoh.Encoding.APPLICATION_JSON, attachment=str(count))
        else:
            query.reply(query.key_expr, sample.payload, encoding=sample.encoding, attachment=str(count))

    def on_watch(query: zenoh.Query):
        key = query.payload.to_string() if query.payload else ""
        if index.watch(session, key):
            query.reply(query.key_expr, b"")
        else:
            query.reply_err(f"{key} is not a Gazebo topic")

    session.declare_subscriber("**", index.on_sample)
    session.declare_queryable("@sdk/index", on_summary)
    session.declare_queryable("@sdk/index/value", on_value)
    session.declare_queryable("@sdk/index/watch", on_watch)
    session.liveliness().declare_subscriber("@gz/**", index.on_gz_token, history=True)
    print(f"zenoh-index: indexing ** via {ROUTER}", flush=True)

    def discovery():
        while True:
            try:
                index.discover(session)
            except Exception as e:
                print(f"zenoh-index: discovery failed: {e}", flush=True)
            time.sleep(DISCOVER_EVERY)

    threading.Thread(target=discovery, daemon=True).start()
    last = time.monotonic()
    ticks = 0
    while True:
        time.sleep(1)
        now = time.monotonic()
        index.rates(now - last)
        index.unwatch_expired()
        last = now
        ticks += 1
        if ticks % 30 == 0:
            index.forget()


if __name__ == "__main__":
    main()
