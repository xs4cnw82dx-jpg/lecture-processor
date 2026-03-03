from functools import lru_cache

from lecture_processor import create_app
from lecture_processor.runtime.container import get_runtime


@lru_cache(maxsize=1)
def get_test_core():
    return get_runtime(create_app()).core
