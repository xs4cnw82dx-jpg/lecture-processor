from collections import deque
from types import SimpleNamespace

from google.genai import types

from lecture_processor.domains.ai.providers.contracts import AudioPart, ImagePart, PdfPart

MODEL = 'synthetic-model'


class Harness:
    def __init__(self, *, typed=True, outcomes=(), processing_error=None, cleanup_error=False):
        self.generations = []
        self.uploads = []
        self.polls = []
        self.deletes = []
        self.sleeps = []
        self.warnings = []
        self.handles = {}
        self.outcomes = deque(outcomes)
        self.parsed = {'answer': 'synthetic'}
        self.response = SimpleNamespace(
            text='  Exact synthetic response\n', parsed=self.parsed,
            usage_metadata=SimpleNamespace(prompt_token_count=11, candidates_token_count=7,
                                           thoughts_token_count=3, total_token_count=37),
        )

        def generate(**kwargs):
            self.generations.append(kwargs)
            outcome = self.outcomes.popleft() if self.outcomes else self.response
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        def upload(**kwargs):
            self.uploads.append(kwargs)
            handle = SimpleNamespace(name=f'files/synthetic-{len(self.uploads)}',
                                     uri=f'https://example.test/files/{len(self.uploads)}',
                                     state=SimpleNamespace(name='ACTIVE'))
            self.handles[handle.name] = handle
            return handle

        def get(*, name):
            self.polls.append(name)
            if processing_error is not None:
                raise processing_error
            return self.handles[name]

        def delete(*, name):
            self.deletes.append(name)
            if cleanup_error:
                raise RuntimeError('Synthetic cleanup failure')

        self.client = SimpleNamespace(
            models=SimpleNamespace(generate_content=generate),
            files=SimpleNamespace(upload=upload, get=get, delete=delete),
        )
        self.runtime = SimpleNamespace(
            client=self.client, types=types if typed else SimpleNamespace(),
            MODEL_THINKING_POLICY={MODEL: {'thinking_level': 'high'}},
            PROVIDER_RETRY_MAX_ATTEMPTS=3, PROVIDER_RETRY_BASE_SECONDS=0.25,
            PROVIDER_RETRY_MAX_SECONDS=1.0, PROVIDER_TRANSIENT_STATUS_CODES={503},
            PROVIDER_TRANSIENT_MESSAGE_HINTS=('timeout',),
            random=SimpleNamespace(uniform=lambda _low, _high: 0.0),
            time=SimpleNamespace(sleep=self.sleeps.append),
            logger=SimpleNamespace(warning=lambda *args: self.warnings.append(args)),
        )


def local_parts(tmp_path):
    paths = [tmp_path / name for name in ('synthetic.pdf', 'synthetic.png', 'synthetic.wav')]
    for path in paths:
        path.write_bytes(b'Synthetic local fixture; never uploaded to a real service.')
    return [PdfPart(paths[0]), ImagePart(paths[1]), AudioPart(paths[2], 'audio/wav')]


def serialized_contents(call):
    return [item.model_dump(mode='json', exclude_none=True) if hasattr(item, 'model_dump') else item
            for item in call['contents']]
