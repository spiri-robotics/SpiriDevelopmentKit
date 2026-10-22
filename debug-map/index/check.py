"""Checking SpiriSynq field values against their object's schema.

A Checker is built from one object's sr_object_schema (JSON Schema 2020-12
with x- keywords; docs/protocol.md §9 in SpiriSynq) and says what, if
anything, is wrong with a value put at one of the object's field keys.
"""

import base64
import datetime

import yaml
from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match

YAML = ("application/yaml", "text/yaml")


# PyYAML, as SpiriSynq writes, but loading local tags (!Gimbal, !EventedList)
# as the plain mapping, sequence or scalar they tag. !!binary and !!set are
# standard and load as bytes and set.
class _Loader(yaml.SafeLoader):
    pass


def _untagged(loader, _suffix, node):
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_scalar(node)


_Loader.add_multi_constructor("!", _untagged)


# Python values as the schema describes them: bytes are base64 strings,
# sets and tuples are arrays.
def _as_json(v):
    if isinstance(v, bytes):
        return base64.b64encode(v).decode()
    if isinstance(v, (set, frozenset)):
        return sorted((_as_json(x) for x in v), key=repr)
    if isinstance(v, (list, tuple)):
        return [_as_json(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _as_json(x) for k, x in v.items()}
    if isinstance(v, (datetime.date, datetime.time)):
        return v.isoformat()
    return v


class Checker:
    def __init__(self, schema: dict):
        self.schema = schema
        self.title = schema.get("title") or "this object"
        self.defs = schema.get("$defs") or {}
        self.methods = set(schema.get("x-rpc-endpoints") or {})
        self.validators: dict[tuple, Draft202012Validator] = {}

    # The properties of an object schema, through $refs and `X | None`.
    def _properties(self, s: dict):
        ref = s.get("$ref")
        if ref == "#":
            s = self.schema
        elif ref and ref.startswith("#/$defs/"):
            s = self.defs.get(ref[len("#/$defs/"):], {})
        if "properties" in s:
            return s["properties"]
        for alt in s.get("anyOf") or []:
            if (props := self._properties(alt)) is not None:
                return props
        return None

    def _field(self, chunks: list[str]):
        s = self.schema
        for c in chunks:
            props = self._properties(s)
            if props is None or c not in props:
                return None
            s = props[c]
        return s

    # What's wrong with a put at `<topic>/<chunks…>`, or None.
    def check(self, chunks: list[str], encoding: str, payload: bytes) -> str | None:
        # Protocol keys and methods are queryables, not fields.
        if chunks[0].startswith("sr_") or chunks[0] in self.methods:
            return None
        s = self._field(chunks)
        if s is None:
            return f"not a field of {self.title}"
        if not encoding.startswith(YAML):
            # A codec field (x-encoding) is sent in its own encoding.
            want = s.get("x-encoding")
            if want and encoding.startswith(want):
                return None
            return f"sent as {encoding}, expected YAML" + (f" or {want}" if want else "")
        try:
            value = _as_json(yaml.load(payload, Loader=_Loader))
        except yaml.YAMLError as e:
            return f"not YAML: {str(e).splitlines()[0]}"
        key = tuple(chunks)
        validator = self.validators.get(key)
        if validator is None:
            validator = self.validators[key] = Draft202012Validator({**s, "$defs": self.defs})
        error = best_match(validator.iter_errors(value))
        if error is None:
            return None
        where = "/".join(str(p) for p in error.absolute_path)
        return (f"{where}: " if where else "") + error.message[:200]
