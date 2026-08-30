"""Context compiler (P3-4).

Replaces naive prompt concatenation with a staged, *measured* pipeline:

    system core -> role block -> top-k memory selection -> recursive history
    summarization -> task inputs

Every stage records its token contribution, so the assembled prompt is
byte-reconstructable from the log and the cost of each stage is attributable. The
reduction comes from selecting the top-k memory items (not dumping the store) and
summarizing old history turns instead of replaying them verbatim. The summarizer is
deterministic here (a real LLM summarizer swaps in behind ``Summarizer``).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol

# token counter: ~4 chars/token, matching providers.base.approx_tokens
TokenCounter = Callable[[str], int]


def _count(text: str) -> int:
    return max(0, len(text) // 4)


class Summarizer(Protocol):
    def summarize(self, turns: list[dict[str, str]], max_chars: int) -> str: ...


class TruncatingSummarizer:
    """Deterministic synopsis of old turns: a count + a clipped digest. Stands in for
    an LLM summarizer behind the same port."""

    def summarize(self, turns: list[dict[str, str]], max_chars: int) -> str:
        joined = " | ".join(f"{t.get('role', '?')}: {t.get('content', '')}" for t in turns)
        digest = joined[:max_chars]
        return f"[summary of {len(turns)} earlier turns] {digest}"


@dataclass
class CompiledContext:
    messages: list[dict[str, str]]
    stage_tokens: dict[str, int] = field(default_factory=dict)

    @property
    def total_tokens(self) -> int:
        return sum(self.stage_tokens.values())


class ContextCompiler:
    def __init__(self, counter: Optional[TokenCounter] = None,
                 summarizer: Optional[Summarizer] = None,
                 keep_recent_turns: int = 4, top_k_memory: int = 3,
                 summary_max_chars: int = 200) -> None:
        self._count = counter or _count
        self._summarizer = summarizer or TruncatingSummarizer()
        self._keep = keep_recent_turns
        self._k = top_k_memory
        self._summary_max = summary_max_chars

    def compile(self, *, system: str = "", role: str = "", prompt: str = "",
                inputs: str = "", history: Optional[list[dict[str, str]]] = None,
                memory: Optional[list[str]] = None) -> CompiledContext:
        history = history or []
        memory = memory or []
        stages: dict[str, int] = {}
        messages: list[dict[str, str]] = []

        sys_parts = [p for p in (system, role) if p]
        sys_text = "\n\n".join(sys_parts)
        if sys_text:
            messages.append({"role": "system", "content": sys_text})
        stages["system"] = self._count(system)
        stages["role"] = self._count(role)

        # top-k memory selection (cap, don't dump the store)
        selected = memory[: self._k]
        if selected:
            mem_text = "Relevant memory:\n" + "\n".join(f"- {m}" for m in selected)
            messages.append({"role": "system", "content": mem_text})
            stages["memory"] = self._count(mem_text)
        else:
            stages["memory"] = 0

        # recursive history summarization: keep the most recent turns verbatim,
        # summarize everything older into one synopsis turn.
        hist_tokens = 0
        if len(history) > self._keep:
            old, recent = history[: -self._keep], history[-self._keep:]
            synopsis = self._summarizer.summarize(old, self._summary_max)
            messages.append({"role": "system", "content": synopsis})
            hist_tokens += self._count(synopsis)
            for turn in recent:
                messages.append(turn)
                hist_tokens += self._count(turn.get("content", ""))
        else:
            for turn in history:
                messages.append(turn)
                hist_tokens += self._count(turn.get("content", ""))
        stages["history"] = hist_tokens

        user = prompt
        if inputs:
            user = f"{prompt}\n\nInputs:\n{inputs}"
        messages.append({"role": "user", "content": user})
        stages["inputs"] = self._count(user)

        return CompiledContext(messages=messages, stage_tokens=stages)

    def naive_tokens(self, *, system: str = "", role: str = "", prompt: str = "",
                     inputs: str = "", history: Optional[list[dict[str, str]]] = None,
                     memory: Optional[list[str]] = None) -> int:
        """Token count of the naive 'concatenate everything verbatim' baseline, for
        measuring the compiler's reduction."""
        history = history or []
        memory = memory or []
        text = "\n".join(
            [system, role, *memory, *(t.get("content", "") for t in history), prompt, inputs])
        return self._count(text)
