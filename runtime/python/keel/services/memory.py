"""Memory subsystem v1 (P2-9).

A KV store and a vector store behind ports, plus a deterministic embedder (no ML
dependency in core). The key property: every read and write goes through
``TracedMemory`` and emits a ``memory.read`` / ``memory.write`` event, so the exact
context an agent was given is reconstructable from the log — memory is not an
invisible side channel (invariant #1). Memory can be disabled with a single flag,
in which case it is inert and emits nothing.
"""
from __future__ import annotations
import hashlib
import json
import math
from typing import Optional, Protocol, runtime_checkable
from ..substrate.events import EventType
from ..executor.engine import RunContext

EMBED_DIM = 64


@runtime_checkable
class Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...


class HashEmbedder:
    """Deterministic, dependency-free embedding: hashes token n-grams into a fixed
    vector and L2-normalizes. Good enough for traced retrieval and tests; swap for a
    real embedder behind the same port in production."""

    def __init__(self, dim: int = EMBED_DIM) -> None:
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        toks = text.lower().split()
        for tok in toks:
            # Non-cryptographic: SHA-1 is used only to bucket tokens into vector
            # dimensions, never for security. usedforsecurity=False documents that.
            h = int(hashlib.sha1(tok.encode(), usedforsecurity=False).hexdigest(), 16)
            vec[h % self.dim] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


@runtime_checkable
class KVStore(Protocol):
    def get(self, key: str) -> Optional[str]: ...
    def put(self, key: str, value: str) -> None: ...
    def keys(self) -> list[str]: ...


class InMemoryKV:
    def __init__(self) -> None:
        self._d: dict[str, str] = {}

    def get(self, key: str) -> Optional[str]:
        return self._d.get(key)

    def put(self, key: str, value: str) -> None:
        self._d[key] = value

    def keys(self) -> list[str]:
        return sorted(self._d)


@runtime_checkable
class VectorStore(Protocol):
    def add(self, doc_id: str, text: str, vector: list[float]) -> None: ...
    def search(self, vector: list[float], k: int) -> list[tuple[str, str, float]]: ...


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))  # inputs are L2-normalized


class InMemoryVector:
    def __init__(self) -> None:
        self._docs: dict[str, tuple[str, list[float]]] = {}

    def add(self, doc_id: str, text: str, vector: list[float]) -> None:
        self._docs[doc_id] = (text, vector)

    def search(self, vector: list[float], k: int) -> list[tuple[str, str, float]]:
        scored = [(did, text, _cosine(vector, vec))
                  for did, (text, vec) in self._docs.items()]
        scored.sort(key=lambda t: t[2], reverse=True)
        return scored[:k]


class TracedMemory:
    """Wraps the KV + vector stores for one run. Every operation emits an event so
    the retrieved context is in the log; ``enabled=False`` makes it inert."""

    def __init__(self, ctx: RunContext, *, kv: Optional[KVStore] = None,
                 vector: Optional[VectorStore] = None, embedder: Optional[Embedder] = None,
                 enabled: bool = True, node_id: Optional[str] = None) -> None:
        self._ctx = ctx
        self._kv = kv or InMemoryKV()
        self._vec = vector or InMemoryVector()
        self._embed = embedder or HashEmbedder()
        self.enabled = enabled
        self._node_id = node_id

    async def remember(self, key: str, value: str) -> None:
        if not self.enabled:
            return
        self._kv.put(key, value)
        await self._ctx.emit(EventType.MEMORY_WRITE, node_id=self._node_id,
                             payload=value.encode(), data={"kind": "kv", "key": key})

    async def recall(self, key: str) -> Optional[str]:
        if not self.enabled:
            return None
        value = self._kv.get(key)
        await self._ctx.emit(EventType.MEMORY_READ, node_id=self._node_id,
                             payload=value.encode() if value is not None else None,
                             data={"kind": "kv", "key": key, "hit": value is not None})
        return value

    async def index(self, doc_id: str, text: str) -> None:
        if not self.enabled:
            return
        self._vec.add(doc_id, text, self._embed.embed(text))
        await self._ctx.emit(EventType.MEMORY_WRITE, node_id=self._node_id,
                             payload=text.encode(), data={"kind": "vector", "doc_id": doc_id})

    async def search(self, query: str, k: int = 3) -> list[tuple[str, str, float]]:
        if not self.enabled:
            return []
        hits = self._vec.search(self._embed.embed(query), k)
        await self._ctx.emit(
            EventType.MEMORY_READ, node_id=self._node_id,
            payload=json.dumps([{"doc_id": d, "text": t, "score": s} for d, t, s in hits]).encode(),
            data={"kind": "vector", "query": query, "k": k, "hits": len(hits)})
        return hits
