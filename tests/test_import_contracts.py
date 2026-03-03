import ast
from pathlib import Path


def _iter_test_python_files():
    files = sorted(Path("tests").glob("test_*.py"))
    files.append(Path("tests/conftest.py"))
    return files


def _find_app_module_imports(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    offenders = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "app":
                    offenders.append(f"{path}:{node.lineno} import app")
        elif isinstance(node, ast.ImportFrom):
            if node.module == "app":
                offenders.append(f"{path}:{node.lineno} from app import ...")
    return offenders


def test_tests_do_not_import_app_module_directly():
    offenders = []
    for path in _iter_test_python_files():
        offenders.extend(_find_app_module_imports(path))
    assert offenders == []
