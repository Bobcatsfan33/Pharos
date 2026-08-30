"""Viewer API smoke test (skipped if the viewer extra isn't installed)."""
import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from keel.authoring import Agent, Task, Crew  # noqa: E402
from keel.services.runner import Runner  # noqa: E402
from keel.services.model.handlers import MockModelPort  # noqa: E402
from keel.viewer.app import create_app  # noqa: E402


@pytest.mark.asyncio
async def test_viewer_serves_run(tmp_path):
    db = str(tmp_path / "k.db")
    blobs = str(tmp_path / "blobs")
    runner = await Runner.open(db_path=db, blob_dir=blobs,
                               model=MockModelPort(reply='{"summary": "hi"}'))
    a = Agent("r", goal="g")
    graph = Crew("vg", tasks=[Task("do it", agent=a, output_schema=None)]).compile()
    await runner.run(graph, run_id="vrun")
    await runner.close()

    with TestClient(create_app(db, blobs)) as client:
        runs = client.get("/api/runs").json()
        assert any(r["run_id"] == "vrun" for r in runs)
        detail = client.get("/api/runs/vrun").json()
        assert detail["status"] == "completed"
        assert detail["events"]
        cost = client.get("/api/runs/vrun/cost").json()
        assert "by_node" in cost
        index = client.get("/")
        assert index.status_code == 200 and "Overview" in index.text  # overhauled SPA
        assert client.get("/api/runs/nope").status_code == 404
        # the Overview aggregate endpoint
        ov = client.get("/api/overview").json()
        assert ov["runs"] >= 1 and "completed" in ov["by_status"]
        assert "vg" in ov["by_graph"] and "total_events" in ov


@pytest.mark.asyncio
async def test_viewer_gate_decision_is_recorded(tmp_path):
    from keel.authoring import Agent, Task, Crew  # noqa: PLC0415
    db = str(tmp_path / "g.db")
    blobs = str(tmp_path / "gblobs")
    runner = await Runner.open(db_path=db, blob_dir=blobs, model=MockModelPort())
    a, b = Agent("r", goal="g"), Agent("e", goal="approve")
    t1 = Task("research", agent=a)
    gate = Task("approve", agent=b, human_gate=True, context=[t1])
    graph = Crew("vg2", tasks=[t1, gate]).compile()
    state = await runner.run(graph, run_id="vg2run")
    assert state.status == "paused"
    await runner.close()

    with TestClient(create_app(db, blobs)) as client:
        r = client.post("/api/runs/vg2run/gates/approve/approve")
        assert r.status_code == 200 and r.json()["decision"] == "approve"

    runner2 = await Runner.open(db_path=db, blob_dir=blobs, model=MockModelPort())
    final = await runner2.resume("vg2run")  # a worker completes the durable decision
    await runner2.close()
    assert final.status == "completed"
