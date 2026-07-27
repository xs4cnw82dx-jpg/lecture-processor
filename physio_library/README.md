# Physio Library (local artifacts only)

Clinical source documents and generated indexes must not be committed to this
repository. They can contain large copyrighted binaries and private study data.

The supported Physio companion stores its private working data under:

```text
~/Library/Application Support/Lecture Processor/Physio/
```

Use `scripts/build_physio_source_manifest.py` to create the local reviewed
manifest. Use the source manager in the local workspace to import, review, and
index documents. The repository keeps only these empty directories so tooling
can refer to stable paths during migration.

The binaries removed in July 2026 were copied and checksum-verified at:

```text
~/Library/Application Support/Lecture Processor/Physio/
  Legacy Repo Library Backup 2026-07-27/
```

Do not rewrite Git history as part of an ordinary feature PR. If the historical
repository size must also be reduced, coordinate a separately backed-up history
rewrite with every collaborator.
