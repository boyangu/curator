"""PyInstaller frozen-binary entry point.

Dev runs the sidecar as `python -m curator_analyzer.main`, which executes
main.py inside its package so relative imports (`from .worker import ...`)
resolve. PyInstaller pointed at main.py directly runs it as `__main__` with
no parent package, breaking those imports. This launcher imports the package
absolutely (with `--paths src`) and calls main().

`multiprocessing.freeze_support()` must run first: the analyzer fans out to a
worker pool, and a frozen binary re-executes itself for each child — without
this guard each child would re-run the JSON-RPC server instead of the worker.
(No-op under fork on Linux, where this is actually bundled, but correct and
required if ever frozen on Windows/macOS.)
"""

import multiprocessing

from curator_analyzer.main import main

if __name__ == "__main__":
	multiprocessing.freeze_support()
	main()
