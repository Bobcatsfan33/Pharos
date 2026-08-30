from keel.executor.state import RunState


async def assert_run_log_sound(store, run_id, graph):
    events = [e async for e in store.read_run(run_id)]
    assert [e.seq for e in events] == list(range(len(events))), "seq not gap-free"
    st = RunState.fold(run_id, graph, events)
    if st.status == "completed":
        assert all(r.status in ("completed", "skipped") for r in st.steps.values())
    assert len({e.seq for e in events}) == len(events), "duplicate seq"
    assert abs(st.total_cost_usd - sum(e.cost_usd for e in events)) < 1e-9
