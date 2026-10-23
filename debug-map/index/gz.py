"""Gazebo's topics, which `**` never sees.

gz-transport's zenoh backend publishes a topic at `@/<partition>@/<topic>`,
and `@` keys only match exactly. It also only publishes a topic while some
node has declared a subscriber to it, as a liveliness token, so subscribing
to everything would make Gazebo send everything, rendering every camera.

So topics are listed from their publishers' liveliness tokens, which cost
nothing, and a topic's messages are only received while someone watches it:
a page asks to, every few seconds, for as long as the topic is selected.
Messages are raw protobuf with the type name as the attachment, decoded here
with gz-msgs' definitions (gz-msgs.desc, built into the image).
"""

import json
import uuid
from pathlib import Path

from google.protobuf import descriptor_pb2, descriptor_pool, json_format, message_factory
from google.protobuf.descriptor import FieldDescriptor

ELIDE = 64  # bytes; longer bytes fields are shown as their size

pool = descriptor_pool.DescriptorPool()
_desc = Path(__file__).with_name("gz-msgs.desc")
if _desc.exists():
    for file in descriptor_pb2.FileDescriptorSet.FromString(_desc.read_bytes()).file:
        pool.Add(file)


def parse_token(token: str):
    """A gz liveliness token: (kind, partition, topic, type), or None.

    `@gz/%<partition>/<process>/<node>/<node>/<kind>/%/%/%/<topic>/<type>/%/%`,
    with the topic's slashes as `%`. Kinds: MP and MS publish and subscribe to
    messages, SS and SC serve and call services.
    """
    chunks = token.split("/")
    if len(chunks) < 11 or chunks[0] != "@gz" or not chunks[1].startswith("%"):
        return None
    return chunks[5], chunks[1][1:], chunks[9].replace("%", "/"), chunks[10]


def key(partition: str, topic: str) -> str:
    return f"@/{partition}@{topic}"


def subscriber_token(partition: str, topic: str, msg_type: str) -> str:
    """The token a gz node subscribing to `topic` declares."""
    node = uuid.uuid4()
    return f"@gz/%{partition}/{uuid.uuid4()}/{node}/{node}/MS/%/%/%/{topic.replace('/', '%')}/{msg_type}/%/%"


def _elided(msg) -> dict:
    """The message as a dict, with long bytes fields replaced by their size."""
    out = json_format.MessageToDict(msg, preserving_proto_field_name=True)
    for field, value in msg.ListFields():
        name = field.name
        if field.type == FieldDescriptor.TYPE_BYTES:
            if field.label == FieldDescriptor.LABEL_REPEATED:
                out[name] = [v if len(b) <= ELIDE else f"<{len(b)} bytes>" for v, b in zip(out[name], value)]
            elif len(value) > ELIDE:
                out[name] = f"<{len(value)} bytes>"
        elif field.type == FieldDescriptor.TYPE_MESSAGE and not field.message_type.GetOptions().map_entry:
            if field.label == FieldDescriptor.LABEL_REPEATED:
                out[name] = [_elided(m) for m in value]
            else:
                out[name] = _elided(value)
    return out


def decode(msg_type: str, payload: bytes) -> str:
    """A gz message as indented JSON, or why it couldn't be decoded."""
    try:
        cls = message_factory.GetMessageClass(pool.FindMessageTypeByName(msg_type))
    except KeyError:
        return json.dumps({"undecoded": f"unknown message type {msg_type}", "size": len(payload)})
    try:
        return json.dumps(_elided(cls.FromString(payload)), indent=2)
    except Exception as e:
        return json.dumps({"undecoded": str(e), "size": len(payload)})
