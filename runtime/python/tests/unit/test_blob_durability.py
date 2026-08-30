"""FileBlobStore durability: blob bytes are fsync'd BEFORE the rename publishes
them, and the directory entry is fsync'd after — a crash right after put() must
never leave a published-but-empty blob."""
import os

from keel.substrate.ports import FileBlobStore


def test_put_fsyncs_file_before_rename_and_dir_after(tmp_path, monkeypatch):
    calls: list[str] = []
    real_fsync, real_replace = os.fsync, os.replace
    monkeypatch.setattr(os, "fsync", lambda fd: (calls.append("fsync"), real_fsync(fd))[1])
    monkeypatch.setattr(
        os, "replace", lambda src, dst: (calls.append("replace"), real_replace(src, dst))[1]
    )

    store = FileBlobStore(root=str(tmp_path / "blobs"))
    ref = store.put(b"payload")

    assert store.get(ref) == b"payload"
    assert "replace" in calls and calls.index("fsync") < calls.index("replace")
    if hasattr(os, "O_DIRECTORY"):  # POSIX: the directory entry is also synced
        assert calls[calls.index("replace") + 1] == "fsync"

    calls.clear()
    store.put(b"payload")  # content-addressed: second put is a no-op, no re-sync
    assert calls == []
