from __future__ import annotations
from typing import Protocol, runtime_checkable, Any, Sequence
from datetime import datetime, timezone
import os
import hashlib
import time as _time
import random as _random
from ulid import ULID


@runtime_checkable
class Clock(Protocol):
    def now(self) -> datetime: ...
    def monotonic(self) -> float: ...


@runtime_checkable
class IdGen(Protocol):
    def new(self) -> str: ...


@runtime_checkable
class Rng(Protocol):
    def random(self) -> float: ...
    def choice(self, seq: Sequence[Any]) -> Any: ...


@runtime_checkable
class BlobStore(Protocol):
    def put(self, data: bytes) -> str: ...
    def get(self, ref: str) -> bytes: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def monotonic(self) -> float:
        return _time.monotonic()


class UlidIdGen:
    def new(self) -> str:
        return str(ULID())


class SeededRng:
    def __init__(self, seed: int) -> None:
        self._r = _random.Random(seed)

    def random(self) -> float:
        return self._r.random()

    def choice(self, seq: Sequence[Any]) -> Any:
        return self._r.choice(seq)


class ReplayClock:
    """Returns the timestamps recorded in the event log, in order, so every now()
    during replay returns exactly what it returned originally."""

    def __init__(self, recorded: list[datetime]) -> None:
        self._recorded = list(recorded)
        self._i = 0

    def now(self) -> datetime:
        v = self._recorded[self._i]
        self._i += 1
        return v

    def monotonic(self) -> float:
        self._i += 1
        return float(self._i)


class ReplayIdGen:
    def __init__(self, recorded: list[str]) -> None:
        self._recorded = list(recorded)
        self._i = 0

    def new(self) -> str:
        v = self._recorded[self._i]
        self._i += 1
        return v


class FileBlobStore:
    """Content-addressed blob store. Large payloads live here keyed by sha256; the
    event log only stores the 'blob:sha256:...' reference."""

    def __init__(self, root: str = "blobs") -> None:
        self._root = root
        os.makedirs(root, exist_ok=True)

    def put(self, data: bytes) -> str:
        digest = hashlib.sha256(data).hexdigest()
        path = os.path.join(self._root, digest)
        if not os.path.exists(path):
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())  # blob bytes durable before the rename publishes them
            os.replace(tmp, path)  # atomic, idempotent (content-addressed)
            if hasattr(os, "O_DIRECTORY"):  # POSIX: persist the directory entry too
                dfd = os.open(self._root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(dfd)
                finally:
                    os.close(dfd)
        return f"blob:sha256:{digest}"

    def get(self, ref: str) -> bytes:
        digest = ref.removeprefix("blob:sha256:")
        with open(os.path.join(self._root, digest), "rb") as f:
            return f.read()


class MemoryBlobStore:
    """In-process blob store for tests and single-shot runs."""

    def __init__(self) -> None:
        self._d: dict[str, bytes] = {}

    def put(self, data: bytes) -> str:
        digest = hashlib.sha256(data).hexdigest()
        self._d[digest] = data
        return f"blob:sha256:{digest}"

    def get(self, ref: str) -> bytes:
        return self._d[ref.removeprefix("blob:sha256:")]
