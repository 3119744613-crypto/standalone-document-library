# Third-party notices

[Yuxi](https://github.com/xerrors/Yuxi), commit
`d633378c7ea55618ac659a547bfe90f74b29af4c`, was reviewed as a design reference
for document lifecycle states and source previews. Its MIT copyright and permission
notice remains in [third-party/YUXI-LICENSE](third-party/YUXI-LICENSE), with the
historical reference manifest in [upstream.lock.json](upstream.lock.json).

The native document service introduced in version 0.2 implements its own local document service and does not bundle or call
the Yuxi server, frontend, agent framework, database, models, or deployment services.
The older HTTP adapter is retained only in Git history.

The preserved notice identifies the upstream reference. It does not assign a new
license to this repository's original code. The repository owner has not selected
a repository-wide license yet.

Version 0.3 lives within deep-research and reuses its frontend style, UI utilities and generic SSE reader. It adds an independent general-research engine; the original Agent implementation is not re-licensed or replaced.
