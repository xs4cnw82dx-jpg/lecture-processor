"""A routed provider session that only consumes scripted, local JSON replies."""
from types import SimpleNamespace

from lecture_processor.domains.ai.providers.factory import ProviderSession
from lecture_processor.domains.ai.providers.openrouter_response import parse_response
from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot


def scripted_session(runtime, stages, replies):
    model = 'anthropic/claude-sonnet-5.5'
    route = Route('openrouter', model, {'reasoning_effort': 'medium', 'max_output_tokens': 32768})
    session = ProviderSession(runtime, routes=RoutingSnapshot({stage: route for stage in stages}))
    stream = iter(replies)

    def generate(_model, _parts, **_kwargs):
        text, finish = next(stream)
        return parse_response({
            'choices': [{'finish_reason': finish, 'message': {'content': text}}],
            'usage': {'prompt_tokens': 23, 'completion_tokens': 8, 'total_tokens': 31, 'cost': 0.004,
                      'completion_tokens_details': {'reasoning_tokens': 2}},
        }, model=model)

    session._adapters['openrouter'] = SimpleNamespace(generate=generate, close=lambda: None)
    return session
