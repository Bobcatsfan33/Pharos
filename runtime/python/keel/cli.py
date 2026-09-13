"""``keel`` command-line entrypoint.

    keel run <file.py>        run a graph/crew on the durable local runtime
    keel ls                   list recorded runs
    keel show <run_id>        print a run's full event timeline (the trace)
    keel resume <run_id>      continue a crashed/paused run (no re-billing)
    keel approve <run_id> <node> [--reject]   decide a human gate, then resume
    keel replay <run_id>      re-drive a run from its recorded log (byte-identity check)
    keel diff <run_a> <run_b> show where two runs diverge (prompt/route/cost)
    keel simulate <file.py>   estimate a graph's cost before running it
    keel test record <run_id> scaffold an eval case from a recorded run
    keel regress run --suite <dir>  replay recorded runs as regression tests (CI gate)
    keel audit export <run_id> emit a self-contained run bundle
    keel view                 launch the trace viewer
"""
from __future__ import annotations
import argparse
import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional, NoReturn

from .kir.schema import Graph
from .services.runner import Runner
from .services.pharos import PharosConfig
from .services.model.handlers import MockModelPort
from .services.model.pricing import PriceTable


# --------------------------------------------------------------------------- #
# graph loading
# --------------------------------------------------------------------------- #
def _load_graph(path: str) -> Graph:
    p = Path(path)
    if not p.exists():
        _die(f"file not found: {path}")
    spec = importlib.util.spec_from_file_location("keel_user_graph", p)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["keel_user_graph"] = module
    spec.loader.exec_module(module)

    # A module-level Graph, or a Crew instance (has .compile()).
    for name in ("graph", "GRAPH", "crew", "CREW"):
        obj = getattr(module, name, None)
        if isinstance(obj, Graph):
            return obj
        if obj is not None and not callable(obj) and hasattr(obj, "compile"):
            return _as_graph(obj.compile())
    # Or a factory function returning a Graph or Crew.
    for name in ("build_graph", "build_crew", "make_graph", "make_crew"):
        fn = getattr(module, name, None)
        if callable(fn):
            result = fn()
            return _as_graph(result.compile() if hasattr(result, "compile") else result)
    _die(f"{path}: define a module-level `graph`, a `build_graph()` function, or a `crew`")


def _as_graph(obj: Any) -> Graph:
    if not isinstance(obj, Graph):
        _die("loaded object is not a KIR Graph (did you forget Crew.compile()?)")
    return obj


def _build_model(args: argparse.Namespace) -> Any:
    if getattr(args, "model", None) and not getattr(args, "mock", False):
        from .services.model.providers import build_provider, provider_of
        return build_provider(provider_of(args.model))
    if getattr(args, "model", None) is None or getattr(args, "mock", False):
        if not getattr(args, "quiet", False):
            print("[keel] no --model set; using the deterministic mock model "
                  "(set --model anthropic:... for live calls)", file=sys.stderr)
    return MockModelPort(reply=getattr(args, "mock_reply", None) or '{"ok": true}')


async def _runner(args: argparse.Namespace, model: Optional[Any] = None) -> Runner:
    return await Runner.open(
        db_path=args.db,
        blob_dir=args.blobs,
        model=model,
        pharos=_build_pharos(args),
    )


def _build_pharos(args: argparse.Namespace) -> PharosConfig | None:
    url = getattr(args, "pharos_url", None)
    key = getattr(args, "pharos_api_key", None)
    tenant = getattr(args, "pharos_tenant", None)
    if not any((url, key, tenant)):
        return None
    if not all((url, key, tenant)):
        _die(
            "Pharos governance requires --pharos-url, --pharos-api-key, and "
            "--pharos-tenant (or their PHAROS_* environment variables)"
        )
    assert isinstance(url, str) and isinstance(key, str) and isinstance(tenant, str)
    return PharosConfig(
        base_url=url,
        api_key=key,
        tenant_id=tenant,
        agent_id=getattr(args, "pharos_agent_id", "keel-runtime"),
        deadline_ms=getattr(args, "pharos_deadline_ms", 800),
        max_retries=getattr(args, "pharos_max_retries", 2),
        failure_mode=getattr(args, "pharos_failure_mode", "fail_closed"),
    )


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #
async def cmd_run(args: argparse.Namespace) -> int:
    graph = _load_graph(args.file)
    runner = await _runner(args, _build_model(args))
    try:
        state = await runner.run(graph, run_id=args.run_id)
    finally:
        await runner.close()
    _print_summary(state.run_id, state)
    return 0 if state.status == "completed" else 1


async def cmd_ls(args: argparse.Namespace) -> int:
    runner = await _runner(args)
    try:
        runs = await runner.list_runs(args.limit)
    finally:
        await runner.close()
    if not runs:
        print("no runs recorded")
        return 0
    for r in runs:
        print(f"{r.run_id}  {r.graph_id:<30}  {r.created_at}")
    return 0


async def cmd_show(args: argparse.Namespace) -> int:
    runner = await _runner(args)
    try:
        events = await runner.read_events(args.run_id)
    finally:
        await runner.close()
    if not events:
        _die(f"no events for run '{args.run_id}'")
    for e in events:
        node = f" {e.node_id}" if e.node_id else ""
        cost = f" ${e.cost_usd:.5f}" if e.cost_usd else ""
        tok = f" [{e.tokens.input}->{e.tokens.output}]" if e.tokens else ""
        marker = "  <-- RESUME SEAM" if e.type.value == "run.resumed" else ""
        print(f"#{e.seq:>4} {e.type.value:<22}{node}{tok}{cost}{marker}")
    return 0


async def cmd_resume(args: argparse.Namespace) -> int:
    runner = await _runner(args, _build_model(args))
    try:
        state = await runner.resume(args.run_id)
    finally:
        await runner.close()
    _print_summary(args.run_id, state)
    return 0 if state.status == "completed" else 1


async def cmd_approve(args: argparse.Namespace) -> int:
    runner = await _runner(args, _build_model(args))
    try:
        if args.reject:
            await runner.reject_gate(args.run_id, args.node)
            print(f"rejected gate {args.node} on {args.run_id}")
        else:
            payload = args.payload.encode() if args.payload else None
            await runner.approve_gate(args.run_id, args.node, payload)
            print(f"approved gate {args.node} on {args.run_id}")
        if args.resume:
            state = await runner.resume(args.run_id)
            _print_summary(args.run_id, state)
    finally:
        await runner.close()
    return 0


async def cmd_replay(args: argparse.Namespace) -> int:
    from .services.replay import replay_recorded, replay_patched
    runner = await _runner(args, _build_model(args) if args.from_step else None)
    try:
        graph_json = await runner.catalog.get_graph(args.run_id)
        if graph_json is None:
            _die(f"unknown run '{args.run_id}'")
        graph = Graph.model_validate_json(graph_json)
        events = await runner.read_events(args.run_id)
        if args.from_step:
            patch = json.loads(args.patch) if args.patch else None
            final = await replay_patched(graph, args.run_id, events, runner.blobs,
                                         from_step=args.from_step, patch=patch,
                                         model=_build_model(args))
            _print_summary(f"{args.run_id}:replay", final)
            return 0 if final.status == "completed" else 1
        result = await replay_recorded(graph, args.run_id, events, runner.blobs)
    finally:
        await runner.close()
    print(f"replay {'OK (byte-identical)' if result.identical else 'DIVERGED'}: "
          f"{result.detail}")
    return 0 if result.identical else 1


async def cmd_diff(args: argparse.Namespace) -> int:
    runner = await _runner(args)
    try:
        a = await runner.read_events(args.run_a)
        b = await runner.read_events(args.run_b)
    finally:
        await runner.close()
    from .executor.replay import diff_runs
    for line in diff_runs(a, b):
        print(line)
    return 0


async def cmd_simulate(args: argparse.Namespace) -> int:
    from .services.simulate import simulate_run
    graph = _load_graph(args.file)
    table = PriceTable()
    result = simulate_run(graph, price_table=table,
                          default_output_tokens=int(args.assume_output_tokens))
    print(f"cost simulation for {graph.graph_id}:")
    for n in result.nodes:
        print(f"  {n.node_id:<28} {n.model:<28} "
              f"{n.input_tokens}->{n.output_tokens} tok  ${n.usd:.5f}")
    print(f"  estimated total: ${result.total_usd:.5f}  ({result.total_tokens} tokens)")
    if table.unknown:
        print(f"  (unpriced models, counted as $0: {', '.join(sorted(table.unknown))})")
    return 0


async def cmd_test(args: argparse.Namespace) -> int:
    from .services.evals import EvalCase, EvalRunner
    from .services.evals.junit import to_junit
    if args.action == "record":
        return await _test_record(args)
    if args.action == "run":
        runner = await _runner(args)
        cases = []
        suite = Path(args.suite or ".")
        files = sorted(suite.glob("*.json")) if suite.is_dir() else [suite]
        for f in files:
            try:
                cases.append(EvalCase.model_validate_json(f.read_text()))
            except (ValueError, OSError) as e:
                # Skipping a non-case json is intended; skipping a *malformed* case
                # silently is not — it would shrink the suite and still report
                # "all passed". Name the file and the reason on stderr.
                print(f"{_program_name()}: skipping {f} — not a valid eval case: "
                      f"{type(e).__name__}: {e}", file=sys.stderr)
                continue
        if not cases:
            _die(f"no eval cases found in {suite}")
        er = EvalRunner(runner.store, runner.blobs)
        report = await er.run_suite(cases, n_flake=args.flake)
        await runner.close()
        if args.junit:
            Path(args.junit).write_text(to_junit(report))
            print(f"wrote JUnit -> {args.junit}")
        print(f"eval: {report['passed']}/{report['total']} passed, "
              f"{report['failed']} failed, flaky={report['flaky']}")
        return 0 if report["failed"] == 0 else 1
    _die("usage: keel test record <run_id> | keel test run --suite <dir>")


async def _test_record(args: argparse.Namespace) -> int:
    runner = await _runner(args)
    try:
        state = await runner.load_state(args.run_id)
    finally:
        await runner.close()
    assertions = []
    for n in state.graph.nodes:
        if n.output_schema:
            assertions.append({"type": "schema", "node_id": n.id, "expected": n.output_schema})
    case = {"case_id": f"{state.graph.graph_id}:{args.run_id}",
            "graph_id": state.graph.graph_id, "recorded_run_id": args.run_id,
            "assertions": assertions}
    out = Path(args.out or f"evalcase_{args.run_id}.json")
    out.write_text(json.dumps(case, indent=2))
    print(f"wrote eval case -> {out} ({len(assertions)} assertion(s))")
    return 0


async def cmd_regress(args: argparse.Namespace) -> int:
    """Replay-as-a-test: capture a recorded run into a portable regression bundle, or
    check a directory of bundles (byte-identical replay + optional eval case)."""
    from .services.regression import (RegressionBundle, capture_bundle, run_suite)
    from .services.regression_junit import to_junit
    from .services.evals import EvalCase
    if args.action == "record":
        if not args.run_id:
            _die("usage: keel regress record <run_id> [--out file] [--case eval.json]")
        runner = await _runner(args)
        try:
            graph_json = await runner.catalog.get_graph(args.run_id)
            if graph_json is None:
                _die(f"unknown run '{args.run_id}'")
            graph = Graph.model_validate_json(graph_json)
            events = await runner.read_events(args.run_id)
        finally:
            await runner.close()
        case = None
        if args.case:
            case = EvalCase.model_validate_json(Path(args.case).read_text())
        bundle = capture_bundle(bundle_id=args.bundle_id or args.run_id,
                                run_id=args.run_id, graph=graph, events=events,
                                blobs=runner.blobs, eval_case=case)
        out = Path(args.out or f"regression_{args.run_id}.json")
        out.write_text(bundle.model_dump_json(indent=2))
        print(f"wrote regression bundle -> {out} "
              f"({len(bundle.events)} events, {len(bundle.blobs)} blobs"
              f"{', +eval case' if case else ''})")
        return 0
    if args.action == "run":
        suite = Path(args.suite or "tests/regression/suite")
        files = sorted(suite.glob("*.json")) if suite.is_dir() else [suite]
        bundles = []
        for f in files:
            try:
                bundles.append(RegressionBundle.model_validate_json(f.read_text()))
            except (ValueError, OSError) as e:
                # Same contract as the eval suite above: a file that cannot be read
                # as a bundle is skipped, but never without saying so.
                print(f"{_program_name()}: skipping {f} — not a valid regression "
                      f"bundle: {type(e).__name__}: {e}", file=sys.stderr)
                continue
        if not bundles:
            _die(f"no regression bundles found in {suite}")
        report = await run_suite(bundles, n_flake=args.flake)
        if args.junit:
            Path(args.junit).write_text(to_junit(report))
            print(f"wrote JUnit -> {args.junit}")
        for f in report["findings"]:
            mark = "REGRESSED" if f["bundle_id"] in report["regressed"] else (
                "flaky" if f["bundle_id"] in report["flaky"] else "ok")
            detail = f["replay_detail"] if not f["replay_identical"] else f.get("eval_detail", "")
            print(f"  [{mark:>9}] {f['bundle_id']}  {detail}")
        print(f"regression: {report['passed']}/{report['total']} passed, "
              f"{len(report['regressed'])} regressed, flaky={report['flaky']}")
        return 0 if not report["regressed"] else 1
    _die("usage: keel regress record <run_id> | keel regress run --suite <dir>")


async def cmd_migrate(args: argparse.Namespace) -> int:
    from .substrate.events import SCHEMA_VERSION
    from .substrate.upcast import UnreadableEvent
    runner = await _runner(args)
    run_ids = ([args.run_id] if args.run_id
               else [r.run_id for r in await runner.list_runs(args.limit)])
    bad = 0
    try:
        for rid in run_ids:
            try:
                events = await runner.read_events(rid)  # store read upcasts to current
                print(f"{rid}: {len(events)} event(s) readable under schema v{SCHEMA_VERSION}")
            except UnreadableEvent as e:
                bad += 1
                print(f"{rid}: UNREADABLE — {e} (register an upcaster)", file=sys.stderr)
    finally:
        await runner.close()
    if bad:
        print(f"\n{bad} run(s) have un-upcastable events.", file=sys.stderr)
    return 0 if bad == 0 else 1


async def cmd_audit(args: argparse.Namespace) -> int:
    from .services.audit import make_bundle, verify_bundle, verify_bundle_report
    secret = os.environ.get("KEEL_AUDIT_SECRET")
    if args.action == "verify":
        bundle = json.loads(Path(args.run_id).read_text())  # run_id holds the path here
        ok, detail = verify_bundle(bundle, secret=secret)
        if args.json:
            print(json.dumps(verify_bundle_report(bundle, secret=secret), sort_keys=True))
        else:
            print(f"audit {'OK' if ok else 'TAMPERED'}: {detail}")
        return 0 if ok else 1
    if args.action != "export":
        _die("usage: keel audit export <run_id> | keel audit verify <bundle.json>")
    runner = await _runner(args)
    try:
        events = await runner.read_events(args.run_id)
        graph_json = await runner.catalog.get_graph(args.run_id)
    finally:
        await runner.close()
    bundle = make_bundle(args.run_id, events,
                         graph=json.loads(graph_json) if graph_json else None,
                         secret=secret)
    out = Path(args.out or f"audit_{args.run_id}.json")
    out.write_text(json.dumps(bundle, indent=2))
    signed = " (signed)" if secret else ""
    if args.json:
        print(json.dumps({
            "out": str(out),
            "run_id": args.run_id,
            "event_count": len(events),
            "head": bundle["head"],
            "signed": secret is not None,
        }, sort_keys=True))
    else:
        print(f"wrote audit bundle -> {out} ({len(events)} events, head={bundle['head'][:12]}){signed}")
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    if args.framework != "crewai":
        _die("only 'crewai' import is supported")
    from .authoring.import_crewai import load_crewai_dir, load_yaml_pair, unconverted
    crew = load_crewai_dir(args.path, graph_id=args.graph_id)
    graph = crew.compile()
    agents, tasks = load_yaml_pair(args.path)
    notes = unconverted(agents, tasks)
    out = Path(args.out or f"{graph.graph_id}.kir.json")
    out.write_text(graph.model_dump_json(indent=2))
    print(f"imported {len(graph.nodes)} nodes -> {out}")
    for n in notes:
        print(f"  [unconverted] {n}", file=sys.stderr)
    return 0


def cmd_view(args: argparse.Namespace) -> int:
    try:
        from .viewer.app import serve
    except ImportError:
        _die("viewer extra not installed. Install with: pip install 'keel[viewer]'")
    print(f"[keel] viewer on http://{args.host}:{args.port}  (db={args.db})")
    serve(db_path=args.db, blob_dir=args.blobs, host=args.host, port=args.port)
    return 0


# --------------------------------------------------------------------------- #
# helpers + parser
# --------------------------------------------------------------------------- #
def _print_summary(run_id: str, state: Any) -> None:
    print(f"run {run_id} -> {state.status}")
    print("  steps:", {k: v.status for k, v in state.steps.items()})
    print(f"  cost ${state.total_cost_usd:.6f}  tokens "
          f"{state.total_tokens_in}->{state.total_tokens_out}")


def _program_name() -> str:
    executable = Path(sys.argv[0]).name.lower()
    return "pharos" if executable.startswith("pharos") else "keel"


def _die(msg: str) -> NoReturn:
    print(f"{_program_name()}: error: {msg}", file=sys.stderr)
    raise SystemExit(2)


def _default_db() -> str:
    if "PHAROS_RUNTIME_DB" in os.environ:
        return os.environ["PHAROS_RUNTIME_DB"]
    if "KEEL_DB" in os.environ:
        return os.environ["KEEL_DB"]
    data = os.environ.get("PHAROS_RUNTIME_DATA_DIR") or os.environ.get("KEEL_DATA_DIR")
    return f"{data.rstrip('/')}/keel.db" if data else "keel.db"


def _default_blobs() -> str:
    if "PHAROS_RUNTIME_BLOBS" in os.environ:
        return os.environ["PHAROS_RUNTIME_BLOBS"]
    if "KEEL_BLOBS" in os.environ:
        return os.environ["KEEL_BLOBS"]
    data = os.environ.get("PHAROS_RUNTIME_DATA_DIR") or os.environ.get("KEEL_DATA_DIR")
    return f"{data.rstrip('/')}/blobs" if data else "blobs"


def _add_store_args(p: argparse.ArgumentParser) -> None:
    # Branded environment names win, with KEEL_* retained for compatibility.
    p.add_argument("--db", default=_default_db())
    p.add_argument("--blobs", default=_default_blobs())


def _default_model() -> str | None:
    return os.environ.get("PHAROS_RUNTIME_MODEL") or os.environ.get("KEEL_MODEL")


def _add_pharos_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--pharos-url", default=os.environ.get("PHAROS_URL"))
    p.add_argument("--pharos-api-key", default=os.environ.get("PHAROS_API_KEY"))
    p.add_argument("--pharos-tenant", default=os.environ.get("PHAROS_TENANT_ID"))
    p.add_argument(
        "--pharos-agent-id", default=os.environ.get("PHAROS_AGENT_ID", "keel-runtime")
    )
    p.add_argument(
        "--pharos-deadline-ms",
        type=int,
        default=int(os.environ.get("PHAROS_DEADLINE_MS", "800")),
    )
    p.add_argument(
        "--pharos-max-retries",
        type=int,
        default=int(os.environ.get("PHAROS_MAX_RETRIES", "2")),
    )
    p.add_argument(
        "--pharos-failure-mode",
        choices=["fail_closed", "fail_open"],
        default=os.environ.get("PHAROS_FAILURE_MODE", "fail_closed"),
    )


def build_parser(prog: str | None = None) -> argparse.ArgumentParser:
    program = prog or _program_name()
    parser = argparse.ArgumentParser(prog=program, description="Pharos governed agent runtime")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="run a graph/crew file")
    p_run.add_argument("file")
    p_run.add_argument("--run-id", dest="run_id", default=None)
    p_run.add_argument("--model", default=_default_model())
    p_run.add_argument("--mock", action="store_true")
    p_run.add_argument("--mock-reply", dest="mock_reply", default=None)
    p_run.add_argument("--quiet", action="store_true")
    _add_store_args(p_run)
    _add_pharos_args(p_run)
    p_run.set_defaults(func=cmd_run, _async=True)

    p_ls = sub.add_parser("ls", help="list recorded runs")
    p_ls.add_argument("--limit", type=int, default=50)
    _add_store_args(p_ls)
    p_ls.set_defaults(func=cmd_ls, _async=True)

    p_show = sub.add_parser("show", help="print a run's event timeline")
    p_show.add_argument("run_id")
    _add_store_args(p_show)
    p_show.set_defaults(func=cmd_show, _async=True)

    p_res = sub.add_parser("resume", help="continue a crashed/paused run")
    p_res.add_argument("run_id")
    p_res.add_argument("--model", default=_default_model())
    p_res.add_argument("--mock", action="store_true")
    p_res.add_argument("--quiet", action="store_true")
    _add_store_args(p_res)
    _add_pharos_args(p_res)
    p_res.set_defaults(func=cmd_resume, _async=True)

    p_app = sub.add_parser("approve", help="approve/reject a human gate")
    p_app.add_argument("run_id")
    p_app.add_argument("node")
    p_app.add_argument("--reject", action="store_true")
    p_app.add_argument("--payload", default=None)
    p_app.add_argument("--resume", action="store_true", help="resume after deciding")
    p_app.add_argument("--model", default=_default_model())
    p_app.add_argument("--mock", action="store_true")
    p_app.add_argument("--quiet", action="store_true")
    _add_store_args(p_app)
    _add_pharos_args(p_app)
    p_app.set_defaults(func=cmd_approve, _async=True)

    p_rep = sub.add_parser("replay", help="recorded byte-identical or patched replay")
    p_rep.add_argument("run_id")
    p_rep.add_argument("--from", dest="from_step", default=None,
                       help="patched replay: re-run from this node live")
    p_rep.add_argument("--patch", default=None, help="JSON to splice as --from's output")
    p_rep.add_argument("--model", default=_default_model())
    p_rep.add_argument("--mock", action="store_true")
    p_rep.add_argument("--quiet", action="store_true")
    _add_store_args(p_rep)
    p_rep.set_defaults(func=cmd_replay, _async=True)

    p_diff = sub.add_parser("diff", help="diff two runs")
    p_diff.add_argument("run_a")
    p_diff.add_argument("run_b")
    _add_store_args(p_diff)
    p_diff.set_defaults(func=cmd_diff, _async=True)

    p_sim = sub.add_parser("simulate", help="estimate a graph's cost")
    p_sim.add_argument("file")
    p_sim.add_argument("--assume-input-tokens", default=1000)
    p_sim.add_argument("--assume-output-tokens", default=500)
    p_sim.set_defaults(func=cmd_simulate, _async=True)

    p_test = sub.add_parser("test", help="eval-case tooling")
    p_test.add_argument("action", choices=["record", "run"])
    p_test.add_argument("run_id", nargs="?", default=None)
    p_test.add_argument("--out", default=None)
    p_test.add_argument("--suite", default=None, help="dir of eval case .json files")
    p_test.add_argument("--junit", default=None, help="write JUnit XML to this path")
    p_test.add_argument("--flake", type=int, default=3, help="runs per case (flake detection)")
    _add_store_args(p_test)
    p_test.set_defaults(func=cmd_test, _async=True)

    p_reg = sub.add_parser("regress", help="replay recorded runs as regression tests")
    p_reg.add_argument("action", choices=["record", "run"])
    p_reg.add_argument("run_id", nargs="?", default=None)
    p_reg.add_argument("--out", default=None)
    p_reg.add_argument("--bundle-id", dest="bundle_id", default=None)
    p_reg.add_argument("--case", default=None, help="eval case json to embed (record)")
    p_reg.add_argument("--suite", default=None, help="dir of regression bundle .json files")
    p_reg.add_argument("--junit", default=None, help="write JUnit XML to this path")
    p_reg.add_argument("--flake", type=int, default=3, help="eval runs per bundle")
    _add_store_args(p_reg)
    p_reg.set_defaults(func=cmd_regress, _async=True)

    p_aud = sub.add_parser("audit", help="export/verify a tamper-evident run bundle")
    p_aud.add_argument("action", choices=["export", "verify"])
    p_aud.add_argument("run_id", help="run id (export) or bundle path (verify)")
    p_aud.add_argument("--out", default=None)
    p_aud.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    _add_store_args(p_aud)
    p_aud.set_defaults(func=cmd_audit, _async=True)

    p_mig = sub.add_parser("migrate", help="audit event-log readability under the current schema")
    p_mig.add_argument("run_id", nargs="?", default=None, help="run id (default: all runs)")
    p_mig.add_argument("--limit", type=int, default=500)
    _add_store_args(p_mig)
    p_mig.set_defaults(func=cmd_migrate, _async=True)

    p_imp = sub.add_parser("import", help="import another framework's project to KIR")
    p_imp.add_argument("framework", choices=["crewai"])
    p_imp.add_argument("path", help="dir with agents.yaml + tasks.yaml")
    p_imp.add_argument("--graph-id", dest="graph_id", default=None)
    p_imp.add_argument("--out", default=None)
    p_imp.set_defaults(func=cmd_import, _async=False)

    p_view = sub.add_parser("view", help="launch the trace viewer")
    p_view.add_argument("--host", default="127.0.0.1")
    p_view.add_argument("--port", type=int, default=8765)
    _add_store_args(p_view)
    p_view.set_defaults(func=cmd_view, _async=False)

    return parser


def main(argv: Optional[list[str]] = None, *, prog: str | None = None) -> int:
    args = build_parser(prog).parse_args(argv)
    if getattr(args, "_async", False):
        return int(asyncio.run(args.func(args)))
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
