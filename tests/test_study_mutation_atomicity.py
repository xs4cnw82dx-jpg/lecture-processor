from types import SimpleNamespace

from lecture_processor.services import study_library_service


class _Ref:
    def __init__(self, path):
        self._document_path = path


class _Batch:
    def __init__(self):
        self.operations = []
        self.commits = 0

    def update(self, ref, payload):
        self.operations.append(("update", ref._document_path, payload))

    def delete(self, ref):
        self.operations.append(("delete", ref._document_path))

    def commit(self):
        self.commits += 1


def test_related_study_mutations_use_one_firestore_batch():
    batch = _Batch()
    runtime = SimpleNamespace(db=SimpleNamespace(batch=lambda: batch))
    folder_ref = _Ref("study_folders/folder-1")
    pack_ref = _Ref("study_packs/pack-1")

    study_library_service._commit_firestore_mutations(
        runtime,
        updates=[(folder_ref, {"name": "Renamed"})],
        deletes=[pack_ref],
    )

    assert batch.commits == 1
    assert batch.operations == [
        ("update", "study_folders/folder-1", {"name": "Renamed"}),
        ("delete", "study_packs/pack-1"),
    ]
